import { describe, expect, it } from 'vitest';
import { APPROVAL_CHOICES, Refused, applySet, checkAnswer, gatesOf, parseQuestion, turnOf, type SetInput, type WorkRecord } from '../src/shared/work.ts';

const T0 = '2026-11-20T10:00:00.000Z';
const T1 = '2026-11-20T11:00:00.000Z';

function record(over: Partial<WorkRecord> = {}): WorkRecord {
  return {
    id: 1, repo: 'o/r', issue: null, pr: 5, hasDesign: true, gate: 'implementation', state: 'working', reached: 'implementation',
    ask: 'Building it', questions: [], toTest: null, backReason: null, approved: { design: T0 },
    rounds: { design: 1, implementation: 0, prep: 0 }, prepSha: null,
    version: 3, turnSince: T0, writtenAt: T0, confirmedAt: null, startedAt: T0, endedAt: null, endedHow: null,
    ...over,
  };
}

function input(over: Partial<SetInput> = {}): SetInput {
  return { gate: 'implementation', state: 'working', ask: 'Building it', questions: [], toTest: null, reason: null, noDesign: false, headSha: null, isPr: true, ...over };
}

describe('parseQuestion', () => {
  it('reads the choices and the bold default', () => {
    expect(parseQuestion('Colour? (**red** | green)', 1)).toEqual({ n: 1, text: 'Colour?', choices: ['red', 'green'], defaultChoice: 'red' });
  });
  it('throws without a default, or with two', () => {
    expect(() => parseQuestion('Colour? (red | green)', 1)).toThrow(Refused);
    expect(() => parseQuestion('Colour? (**red** | **green**)', 1)).toThrow(Refused);
  });
  it('throws without a choice group', () => {
    expect(() => parseQuestion('Colour?', 1)).toThrow(Refused);
  });
});

describe('applySet: starting', () => {
  it('starts at design', () => {
    const r = applySet(null, input({ gate: 'design' }), T0);
    expect(r).toMatchObject({ version: 1, reached: 'design', hasDesign: true, gate: 'design', state: 'working', turnSince: T0, writtenAt: T0, rounds: { design: 0, implementation: 0, prep: 0 }, approved: {} });
  });
  it('starts at implementation with no design step', () => {
    expect(applySet(null, input({ noDesign: true }), T0).hasDesign).toBe(false);
  });
  it('refuses to start at prep', () => {
    expect(() => applySet(null, input({ gate: 'prep', noDesign: true }), T0)).toThrow(Refused);
  });
  it('refuses to start at implementation when a design step is unapproved', () => {
    expect(() => applySet(null, input(), T0)).toThrow(/design/i);
  });
  it('refuses no-design on a record that already exists', () => {
    expect(() => applySet(record(), input({ noDesign: true }), T1)).toThrow(Refused);
  });
});

describe('applySet: moving between gates', () => {
  it('refuses forward past an unapproved gate, naming it', () => {
    expect(() => applySet(record({ gate: 'design', approved: {} }), input({ gate: 'implementation' }), T1)).toThrow(/design/i);
    expect(() => applySet(record({ approved: { design: T0 } }), input({ gate: 'prep' }), T1)).toThrow(/implementation/i);
  });
  it('lets a record with no design step go to prep once implementation is approved', () => {
    const r = applySet(record({ hasDesign: false, approved: { implementation: T0 } }), input({ gate: 'prep' }), T1);
    expect(r.gate).toBe('prep');
    expect(r.reached).toBe('prep');
  });
  it('moves forward when the gate is approved', () => {
    const r = applySet(record({ gate: 'design', approved: { design: T0 }, reached: 'design' }), input({ gate: 'implementation' }), T1);
    expect(r).toMatchObject({ gate: 'implementation', reached: 'implementation' });
  });
  it('refuses going back without a reason', () => {
    expect(() => applySet(record(), input({ gate: 'design' }), T1)).toThrow(Refused);
  });
  it('going back clears approvals, keeps the furthest gate, and stores the reason', () => {
    const prev = record({ approved: { design: T0, implementation: T0 } });
    const r = applySet(prev, input({ gate: 'design', reason: 'the layout is wrong' }), T1);
    expect(r).toMatchObject({ gate: 'design', reached: 'implementation', backReason: 'the layout is wrong', approved: {} });
  });
  it('going back from prep to implementation keeps the design approval', () => {
    const prev = record({ gate: 'prep', reached: 'prep', approved: { design: T0, implementation: T0 } });
    const r = applySet(prev, input({ gate: 'implementation', reason: 'found a bug' }), T1);
    expect(r.approved).toEqual({ design: T0 });
  });
  it('a record with no design step gains one by going back', () => {
    const r = applySet(record({ hasDesign: false, approved: {} }), input({ gate: 'design', reason: 'needs a design after all' }), T1);
    expect(r.hasDesign).toBe(true);
  });
  it('keeps the earlier reason when moving on without a new one', () => {
    const r = applySet(record({ backReason: 'earlier' }), input(), T1);
    expect(r.backReason).toBe('earlier');
  });
});

describe('applySet: refusals', () => {
  const base = record({ approved: { design: T0, implementation: T0 } });
  it('paused with no questions', () => {
    expect(() => applySet(base, input({ state: 'paused' }), T1)).toThrow(Refused);
  });
  it('complete at implementation with no how to test', () => {
    expect(() => applySet(base, input({ state: 'complete' }), T1)).toThrow(Refused);
  });
  it('parked with an empty ask', () => {
    expect(() => applySet(base, input({ state: 'parked', ask: '  ' }), T1)).toThrow(Refused);
  });
  it('prep on something that is not a PR', () => {
    expect(() => applySet(base, input({ gate: 'prep', isPr: false }), T1)).toThrow(Refused);
  });
  it('a line break anywhere', () => {
    expect(() => applySet(base, input({ ask: 'a\nb' }), T1)).toThrow(Refused);
    expect(() => applySet(base, input({ state: 'paused', questions: ['A\nB (**x** | y)'] }), T1)).toThrow(Refused);
    expect(() => applySet(base, input({ state: 'complete', toTest: 'a\nb' }), T1)).toThrow(Refused);
    expect(() => applySet(base, input({ gate: 'design', reason: 'a\nb' }), T1)).toThrow(Refused);
  });
  it('numbers the questions from 1', () => {
    const r = applySet(base, input({ state: 'paused', questions: ['A? (**x** | y)', 'B? (**p** | q)'] }), T1);
    expect(r.questions.map((q) => q.n)).toEqual([1, 2]);
  });
});

describe('applySet: rounds, prep, version, turn', () => {
  const base = record({ approved: { design: T0, implementation: T0 } });
  it('complete adds a round; working adds none', () => {
    expect(applySet(base, input({ state: 'complete', toTest: 'open it' }), T1).rounds.implementation).toBe(1);
    expect(applySet(base, input({ state: 'working' }), T1).rounds.implementation).toBe(0);
  });
  it('writing complete again at a gate already complete adds no round', () => {
    const complete = record({ state: 'complete', toTest: 'open it', rounds: { design: 1, implementation: 1, prep: 0 } });
    expect(applySet(complete, input({ state: 'complete', toTest: 'open it, then scroll' }), T1).rounds.implementation).toBe(1);
    const paused = record({ state: 'paused', rounds: { design: 1, implementation: 1, prep: 0 } });
    expect(applySet(paused, input({ state: 'complete', toTest: 'open it' }), T1).rounds.implementation).toBe(2);
  });
  it('prep complete stores the head commit, and needs one', () => {
    expect(applySet(base, input({ gate: 'prep', state: 'complete', headSha: 'abc1234' }), T1).prepSha).toBe('abc1234');
    expect(() => applySet(base, input({ gate: 'prep', state: 'complete' }), T1)).toThrow(Refused);
  });
  it('goes up by one each time', () => {
    expect(applySet(base, input(), T1).version).toBe(4);
  });
  it('turnSince moves only when the turn changes', () => {
    expect(applySet(base, input({ state: 'working' }), T1).turnSince).toBe(T0);
    expect(applySet(base, input({ state: 'paused', questions: ['A? (**x** | y)'] }), T1).turnSince).toBe(T1);
    const paused = record({ state: 'paused', turnSince: T0 });
    expect(applySet(paused, input({ state: 'complete', toTest: 'x' }), T1).turnSince).toBe(T0);
  });
});

describe('turnOf and gatesOf', () => {
  it('says whose turn each state is', () => {
    expect(turnOf('paused')).toBe('owner');
    expect(turnOf('complete')).toBe('owner');
    expect(turnOf('working')).toBe('claude');
    expect(turnOf('parked')).toBe('nobody');
  });
  it('leaves out design when there is none', () => {
    expect(gatesOf({ hasDesign: true })).toEqual(['design', 'implementation', 'prep']);
    expect(gatesOf({ hasDesign: false })).toEqual(['implementation', 'prep']);
  });
  it('spells the approval choices', () => {
    expect(APPROVAL_CHOICES.design).toEqual(['approve, build it', 'needs changes']);
    expect(APPROVAL_CHOICES.implementation).toEqual(['looks good, prep for merge', 'needs changes']);
  });
});

describe('checkAnswer', () => {
  const asked = record({ state: 'complete', questions: [parseQuestion('Colour? (**red** | green)', 1)] });
  const ok = { version: 3, choices: {}, approval: null, note: '' };
  it('accepts a good answer', () => {
    expect(checkAnswer(asked, { ...ok, choices: { '1': 'green' }, approval: 'looks good, prep for merge' })).toBeNull();
    expect(checkAnswer(asked, { ...ok, choices: { '1': 'file an issue' } })).toBeNull();
  });
  it('refuses a stale version', () => {
    expect(checkAnswer(asked, { ...ok, version: 2 })).toMatch(/changed/i);
  });
  it('refuses a choice that is not offered, or a question that is not there', () => {
    expect(checkAnswer(asked, { ...ok, choices: { '1': 'blue' } })).not.toBeNull();
    expect(checkAnswer(asked, { ...ok, choices: { '2': 'red' } })).not.toBeNull();
  });
  it('refuses an approval unless the gate is complete, or at prep, or not one of the two choices', () => {
    expect(checkAnswer({ ...asked, state: 'working' }, { ...ok, approval: 'looks good, prep for merge' })).not.toBeNull();
    expect(checkAnswer({ ...asked, state: 'paused' }, { ...ok, approval: 'looks good, prep for merge' })).not.toBeNull();
    expect(checkAnswer({ ...asked, gate: 'prep' }, { ...ok, approval: 'needs changes', note: 'x' })).not.toBeNull();
    expect(checkAnswer(asked, { ...ok, approval: 'approve, build it' })).not.toBeNull();
  });
  it('refuses needs changes with no note', () => {
    expect(checkAnswer(asked, { ...ok, approval: 'needs changes', note: '  ' })).toMatch(/note/i);
    expect(checkAnswer(asked, { ...ok, approval: 'needs changes', note: 'fix it' })).toBeNull();
  });
  it('refuses a note over the limit', () => {
    expect(checkAnswer(asked, { ...ok, note: 'x'.repeat(2001) })).not.toBeNull();
    expect(checkAnswer(asked, { ...ok, note: 'x'.repeat(2000) })).toBeNull();
  });
  it('accepts a note alone in any state', () => {
    for (const state of ['working', 'paused', 'complete', 'parked'] as const) {
      expect(checkAnswer(record({ state }), { ...ok, note: 'a thought' })).toBeNull();
    }
  });
});
