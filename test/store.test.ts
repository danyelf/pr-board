import { beforeEach, describe, expect, it } from 'vitest';
import { GAVE_UP_ASK, SERVICE_WORKING_ASK, WORKING_ASK } from '../src/shared/names.ts';
import { Refused, type AnswerInput, type AnswerRow, type SetInput } from '../src/shared/work.ts';
import {
  addAnswer, claim, confirm, endWork, findWork, giveUp, importWork, openWork, serviceClaims, setStatus, unclaim,
  unclaimedAnswers, unclaimedOlderThan, type Db,
} from '../src/worker/store.ts';
import { sqliteDb } from './sqlite-d1.ts';

const T0 = '2026-11-20T10:00:00.000Z';
const T1 = '2026-11-20T11:00:00.000Z';
const T2 = '2026-11-20T12:00:00.000Z';
const T3 = '2026-11-20T13:00:00.000Z';
const PR = { repo: 'o/r', n: 5 };

function input(over: Partial<SetInput & { issue: number | null; replaces: number | null }> = {}): SetInput & { issue: number | null; replaces: number | null } {
  return {
    gate: 'design', state: 'paused', ask: 'Which one?', questions: ['Colour? (**red** | green)'], toTest: null, reason: null,
    noDesign: false, headSha: null, isPr: true, issue: null, replaces: null, ...over,
  };
}

function answer(over: Partial<AnswerInput> = {}): AnswerInput {
  return { version: 1, choices: { '1': 'red' }, approval: null, note: '', ...over };
}

async function logs(db: Db, workId: number): Promise<{ actor: string; change: string }[]> {
  return (await db.prepare('SELECT actor, change FROM log WHERE work_id = ? ORDER BY id').bind(workId).all<{ actor: string; change: string }>()).results;
}

let db: Db;
beforeEach(() => {
  db = sqliteDb();
});

describe('setStatus and findWork', () => {
  it('round-trips every field', async () => {
    const { record } = await setStatus(db, PR, input({ issue: 3 }), T0);
    expect(await findWork(db, PR)).toEqual(record);
    expect(record).toEqual({
      id: record.id, repo: 'o/r', issue: 3, pr: 5, hasDesign: true, gate: 'design', state: 'paused', reached: 'design',
      ask: 'Which one?', questions: [{ n: 1, text: 'Colour?', choices: ['red', 'green'], defaultChoice: 'red' }], toTest: null,
      backReason: null, approved: {}, rounds: { design: 0, implementation: 0, prep: 0 }, prepSha: null, version: 1,
      turnSince: T0, writtenAt: T0, confirmedAt: null, startedAt: T0, endedAt: null, endedHow: null,
    });
  });

  it('returns null for an unknown item', async () => {
    expect(await findWork(db, PR)).toBeNull();
  });

  it('goes up one version on each set', async () => {
    await setStatus(db, PR, input(), T0);
    const { record } = await setStatus(db, PR, input({ state: 'working', questions: [] }), T1);
    expect(record.version).toBe(2);
    expect(record.startedAt).toBe(T0);
    expect(record.writtenAt).toBe(T1);
  });

  it('finds a record by its issue after a PR is attached', async () => {
    const first = await setStatus(db, { repo: 'o/r', n: 3 }, input({ isPr: false }), T0);
    expect(first.record).toMatchObject({ issue: 3, pr: null });
    const attached = await setStatus(db, PR, input({ issue: 3, state: 'working', questions: [] }), T1);
    expect(attached.record).toMatchObject({ id: first.record.id, issue: 3, pr: 5, version: 2 });
    expect((await findWork(db, { repo: 'o/r', n: 3 }))?.id).toBe(first.record.id);
    expect((await findWork(db, PR))?.id).toBe(first.record.id);
  });

  it('gives a second PR naming the same issue a record of its own, and the first PR keeps its record', async () => {
    await setStatus(db, { repo: 'o/r', n: 3 }, input({ isPr: false }), T0);
    const first = await setStatus(db, { repo: 'o/r', n: 4 }, input({ issue: 3, state: 'working', questions: [] }), T1);
    const second = await setStatus(db, { repo: 'o/r', n: 5 }, input({ issue: 3 }), T2);
    expect(second.record.id).not.toBe(first.record.id);
    expect(second.record).toMatchObject({ pr: 5, issue: null });
    expect(await findWork(db, { repo: 'o/r', n: 4 })).toMatchObject({ id: first.record.id, pr: 4, issue: 3 });
    const next = await setStatus(db, { repo: 'o/r', n: 4 }, input({ issue: 3, state: 'paused' }), T3);
    expect(next.record).toMatchObject({ id: first.record.id, version: 3, pr: 4, issue: 3 });
  });

  it('a replaced PR closing doesn\'t end the record', async () => {
    const first = await setStatus(db, { repo: 'o/r', n: 7 }, input(), T0);
    const moved = await setStatus(db, PR, input({ replaces: 7, state: 'working', questions: [] }), T1);
    expect(moved.record).toMatchObject({ id: first.record.id, pr: 5, endedAt: null });
    expect(await findWork(db, { repo: 'o/r', n: 7 })).toBeNull();
    expect((await openWork(db)).records.map((r) => r.id)).toEqual([first.record.id]);
  });

  it('says it handed over only when the turn moves to the owner', async () => {
    expect((await setStatus(db, PR, input({ state: 'working', questions: [] }), T0)).handedOver).toBe(false);
    expect((await setStatus(db, PR, input({ state: 'paused' }), T1)).handedOver).toBe(true);
    expect((await setStatus(db, PR, input({ state: 'paused' }), T2)).handedOver).toBe(false);
    expect((await setStatus(db, PR, input({ state: 'working', questions: [] }), T3)).handedOver).toBe(false);
  });

  it('hands over on the first status when it is already with the owner', async () => {
    expect((await setStatus(db, PR, input({ state: 'paused' }), T0)).handedOver).toBe(true);
  });

  it('refuses what applySet refuses, and writes nothing', async () => {
    await expect(setStatus(db, PR, input({ state: 'paused', questions: [] }), T0)).rejects.toThrow(Refused);
    expect(await findWork(db, PR)).toBeNull();
  });

  it('keeps ended records out of findWork, and lets the number be used again', async () => {
    const { record } = await setStatus(db, PR, input(), T0);
    await endWork(db, record.id, 'merged', T1);
    expect(await findWork(db, PR)).toBeNull();
    const again = await setStatus(db, PR, input(), T2);
    expect(again.record.id).not.toBe(record.id);
  });
});

describe('confirm', () => {
  it('sets confirmedAt and leaves the version', async () => {
    await setStatus(db, PR, input(), T0);
    const r = await confirm(db, PR, T1);
    expect(r).toMatchObject({ confirmedAt: T1, version: 1 });
  });

  it('throws Refused when there is no record', async () => {
    await expect(confirm(db, PR, T1)).rejects.toThrow(Refused);
  });
});

describe('addAnswer', () => {
  it('stores choices, approval and note', async () => {
    await setStatus(db, PR, input({ state: 'complete', questions: [] }), T0);
    const a = await addAnswer(db, PR, answer({ choices: {}, approval: 'approve, build it', note: 'nice' }), T1);
    expect(a).toMatchObject({ version: 1, at: T1, choices: {}, approval: 'approve, build it', note: 'nice', claimedAt: null, claimedBy: null, stateBefore: null, gaveUpAt: null });
    expect((await findWork(db, PR))?.approved).toEqual({ design: T1 });
  });

  it('does not approve a gate for "needs changes"', async () => {
    await setStatus(db, PR, input({ state: 'complete', questions: [] }), T0);
    await addAnswer(db, PR, answer({ choices: {}, approval: 'needs changes', note: 'redo' }), T1);
    expect((await findWork(db, PR))?.approved).toEqual({});
  });

  it('stores choices for a paused status', async () => {
    await setStatus(db, PR, input(), T0);
    const a = await addAnswer(db, PR, answer({ choices: { '1': 'green' }, note: 'because' }), T1);
    expect(a.choices).toEqual({ '1': 'green' });
  });

  it('refuses what checkAnswer refuses', async () => {
    await setStatus(db, PR, input(), T0);
    await expect(addAnswer(db, PR, answer({ version: 9 }), T1)).rejects.toThrow('This changed since you opened it');
  });

  it('refuses an item with no open record', async () => {
    await expect(addAnswer(db, PR, answer(), T1)).rejects.toThrow(Refused);
  });

  it('refuses a second answer with choices to one version', async () => {
    await setStatus(db, PR, input(), T0);
    await addAnswer(db, PR, answer(), T1);
    await expect(addAnswer(db, PR, answer({ choices: { '1': 'green' } }), T2)).rejects.toThrow(Refused);
    expect((await openWork(db)).answers).toHaveLength(1);
  });

  it('refuses a second approval to one version, and does not move the approval time', async () => {
    await setStatus(db, PR, input({ state: 'complete', questions: [] }), T0);
    await addAnswer(db, PR, answer({ choices: {}, approval: 'approve, build it' }), T1);
    await expect(addAnswer(db, PR, answer({ choices: {}, approval: 'approve, build it' }), T2)).rejects.toThrow(Refused);
    expect((await findWork(db, PR))?.approved).toEqual({ design: T1 });
  });

  it('stores a second note-only answer to the same version', async () => {
    await setStatus(db, PR, input(), T0);
    await addAnswer(db, PR, answer(), T1);
    await addAnswer(db, PR, answer({ choices: {}, note: 'one more thing' }), T2);
    await addAnswer(db, PR, answer({ choices: {}, note: 'and another' }), T3);
    expect((await openWork(db)).answers).toHaveLength(3);
  });

  it('takes a new answer once the version has moved', async () => {
    await setStatus(db, PR, input(), T0);
    await addAnswer(db, PR, answer(), T1);
    await setStatus(db, PR, input(), T2);
    await addAnswer(db, PR, answer({ version: 2 }), T3);
  });
});

describe('claim, unclaim and giveUp', () => {
  async function withTwoAnswers(): Promise<number> {
    const { record } = await setStatus(db, PR, input(), T0);
    await addAnswer(db, PR, answer(), T1);
    await addAnswer(db, PR, answer({ choices: {}, note: 'also' }), T1);
    return record.id;
  }

  it('claims every unclaimed answer and sets the record working', async () => {
    await withTwoAnswers();
    const got = await claim(db, PR, 'session', T2);
    expect(got.answers).toHaveLength(2);
    for (const a of got.answers) expect(a).toMatchObject({ claimedAt: T2, claimedBy: 'session', stateBefore: 'paused' });
    expect(got.record).toMatchObject({ state: 'working', ask: WORKING_ASK, version: 1 });
    expect(await findWork(db, PR)).toEqual(got.record);
  });

  it('uses the service ask for a claim by the service', async () => {
    await withTwoAnswers();
    const got = await claim(db, PR, 'service', T2);
    expect(got.record.ask).toBe(SERVICE_WORKING_ASK);
    expect(got.answers[0]?.claimedBy).toBe('service');
  });

  it('gives nothing to a second claim, and leaves the first claim alone', async () => {
    await withTwoAnswers();
    await claim(db, PR, 'session', T2);
    const second = await claim(db, PR, 'service', T3);
    expect(second.answers).toEqual([]);
    expect(second.record).toMatchObject({ state: 'working', ask: WORKING_ASK });
    expect((await openWork(db)).answers.every((a) => a.claimedBy === 'session')).toBe(true);
  });

  it('claims nothing, and changes nothing, when there are no answers', async () => {
    await setStatus(db, PR, input(), T0);
    const got = await claim(db, PR, 'session', T1);
    expect(got.answers).toEqual([]);
    expect(got.record).toMatchObject({ state: 'paused', ask: 'Which one?' });
  });

  it('throws Refused for an item with no record', async () => {
    await expect(claim(db, PR, 'session', T1)).rejects.toThrow(Refused);
  });

  it('claims an unclaimed answer to an older version, since it may be a note Claude never saw', async () => {
    await setStatus(db, PR, input(), T0);
    await addAnswer(db, PR, answer({ choices: {}, note: 'late thought' }), T1);
    await setStatus(db, PR, input({ ask: 'Again?' }), T2);
    expect((await unclaimedAnswers(db, [PR]))[0]?.answers).toHaveLength(1);
    expect((await unclaimedOlderThan(db, T3))[0]?.answers).toHaveLength(1);
    const got = await claim(db, PR, 'session', T3);
    expect(got.answers).toHaveLength(1);
    expect(got.answers[0]).toMatchObject({ version: 1, claimedAt: T3 });
    expect(got.record).toMatchObject({ state: 'working', ask: WORKING_ASK, version: 2 });
  });

  describe('a late note answering an older version', () => {
    async function lateNote(by: 'session' | 'service'): Promise<number> {
      await setStatus(db, PR, input(), T0);
      const note = await addAnswer(db, PR, answer({ choices: {}, note: 'late thought' }), T1);
      await setStatus(db, PR, input({ ask: 'Again?' }), T2);
      await claim(db, PR, by, T3);
      return note.id;
    }

    it('unclaim restores the record', async () => {
      const id = await lateNote('service');
      expect(await findWork(db, PR)).toMatchObject({ state: 'working', version: 2 });
      await unclaim(db, [id]);
      expect(await findWork(db, PR)).toMatchObject({ state: 'paused', ask: 'Again?', turnSince: T0, version: 2 });
      expect((await unclaimedAnswers(db, [PR]))[0]?.answers).toHaveLength(1);
    });

    it('giveUp hands the record back to the owner', async () => {
      const id = await lateNote('service');
      await giveUp(db, [id], 'h', T3);
      expect(await findWork(db, PR)).toMatchObject({ state: 'paused', ask: GAVE_UP_ASK, turnSince: T3 });
    });

    it('serviceClaims lists the claim', async () => {
      const id = await lateNote('service');
      const got = await serviceClaims(db);
      expect(got).toHaveLength(1);
      expect(got[0]?.answers.map((a) => a.id)).toEqual([id]);
    });

    it('unclaimedOlderThan skips the record while the claim is live', async () => {
      await lateNote('session');
      const second = await addAnswer(db, PR, answer({ version: 2, choices: {}, note: 'more' }), T3);
      expect(second.id).toBeGreaterThan(0);
      expect(await unclaimedOlderThan(db, '2026-11-21T00:00:00.000Z')).toEqual([]);
    });
  });

  it('moves turnSince on a claim, and unclaim puts it back', async () => {
    await withTwoAnswers();
    const got = await claim(db, PR, 'session', T2);
    expect(got.record.turnSince).toBe(T2);
    await unclaim(db, got.answers.map((a) => a.id));
    expect((await findWork(db, PR))?.turnSince).toBe(T0);
  });

  it('moves turnSince when giving up', async () => {
    await withTwoAnswers();
    const got = await claim(db, PR, 'service', T2);
    await giveUp(db, got.answers.map((a) => a.id), 'h', T3);
    expect((await findWork(db, PR))?.turnSince).toBe(T3);
  });

  describe('a note sent while the work is being done', () => {
    async function claimedThenNoted(): Promise<{ first: AnswerRow[]; late: AnswerRow }> {
      await setStatus(db, PR, input(), T0);
      await addAnswer(db, PR, answer(), T1);
      const first = (await claim(db, PR, 'session', T1)).answers;
      const late = await addAnswer(db, PR, answer({ choices: {}, note: 'also, wider' }), T2);
      return { first, late };
    }

    it('is claimed without changing the record, and takes its before-values from the live claim', async () => {
      const { first, late } = await claimedThenNoted();
      const before = await findWork(db, PR);
      const got = await claim(db, PR, 'service', T3);
      expect(got.answers.map((a) => a.id)).toEqual([late.id]);
      expect(got.record).toEqual(before);
      expect(got.answers[0]).toMatchObject({ stateBefore: 'paused', claimedBy: 'service' });
      expect(first[0]?.stateBefore).toBe('paused');
    });

    it('is left to the live claim by the Mac service query', async () => {
      await claimedThenNoted();
      expect(await unclaimedOlderThan(db, T3)).toEqual([]);
      expect(await unclaimedAnswers(db, [PR])).toHaveLength(1);
    });

    it('is offered to the service once the live claim has been given up', async () => {
      const { first } = await claimedThenNoted();
      await giveUp(db, first.map((a) => a.id), 'h', T2);
      expect((await unclaimedOlderThan(db, T3))[0]?.answers).toHaveLength(1);
    });

    it('giving up the late note alone leaves the first claim\'s record as it is', async () => {
      const { late } = await claimedThenNoted();
      await claim(db, PR, 'service', T3);
      await giveUp(db, [late.id], 'h', T3);
      expect(await findWork(db, PR)).toMatchObject({ state: 'working', ask: WORKING_ASK });
    });

    it('giving up never writes working with the gave-up ask', async () => {
      await setStatus(db, PR, input({ state: 'working', questions: [] }), T0);
      const note = await addAnswer(db, PR, answer({ choices: {}, note: 'hi' }), T1);
      const got = await claim(db, PR, 'service', T2);
      expect(got.answers[0]).toMatchObject({ id: note.id, stateBefore: 'working' });
      expect(got.record.state).toBe('working');
      await giveUp(db, [note.id], 'h', T3);
      expect(await findWork(db, PR)).toMatchObject({ state: 'paused', ask: GAVE_UP_ASK, turnSince: T3 });
    });

    it('giving up restores complete when the work was complete', async () => {
      await setStatus(db, PR, input({ state: 'complete', questions: [] }), T0);
      const got0 = await addAnswer(db, PR, answer({ choices: {}, note: 'x' }), T1);
      await claim(db, PR, 'service', T2);
      await giveUp(db, [got0.id], 'h', T3);
      expect(await findWork(db, PR)).toMatchObject({ state: 'complete', ask: GAVE_UP_ASK });
    });
  });

  it('unclaim puts the answers back and restores the record\'s state and ask', async () => {
    await withTwoAnswers();
    const got = await claim(db, PR, 'service', T2);
    await unclaim(db, got.answers.map((a) => a.id));
    expect(await findWork(db, PR)).toMatchObject({ state: 'paused', ask: 'Which one?', version: 1 });
    const again = await claim(db, PR, 'session', T3);
    expect(again.answers).toHaveLength(2);
    expect(again.answers[0]).toMatchObject({ claimedAt: T3, claimedBy: 'session' });
  });

  it('giveUp marks the answers and hands the record back with the hint', async () => {
    const id = await withTwoAnswers();
    const got = await claim(db, PR, 'service', T2);
    await giveUp(db, got.answers.map((a) => a.id), 'output is in /tmp/x.log', T3);
    expect(await findWork(db, PR)).toMatchObject({ id, state: 'paused', ask: GAVE_UP_ASK, toTest: 'output is in /tmp/x.log', version: 1 });
    const { answers } = await openWork(db);
    for (const a of answers) expect(a.gaveUpAt).toBe(T3);
  });

  it('does not offer a given-up answer to be claimed again', async () => {
    await withTwoAnswers();
    const got = await claim(db, PR, 'service', T2);
    await giveUp(db, got.answers.map((a) => a.id), 'hint', T3);
    expect((await claim(db, PR, 'session', T3)).answers).toEqual([]);
  });
});

describe('listing answers', () => {
  it('unclaimedAnswers returns the records of the items asked about that have waiting answers', async () => {
    await setStatus(db, PR, input(), T0);
    await setStatus(db, { repo: 'o/r', n: 6 }, input(), T0);
    await addAnswer(db, PR, answer(), T1);
    const got = await unclaimedAnswers(db, [PR, { repo: 'o/r', n: 6 }, { repo: 'o/r', n: 99 }]);
    expect(got).toHaveLength(1);
    expect(got[0]?.record.pr).toBe(5);
    expect(got[0]?.answers).toHaveLength(1);
  });

  it('unclaimedAnswers finds an item by its issue number', async () => {
    await setStatus(db, { repo: 'o/r', n: 3 }, input({ isPr: false }), T0);
    await setStatus(db, PR, input({ issue: 3 }), T1);
    await addAnswer(db, PR, answer({ version: 2 }), T2);
    expect(await unclaimedAnswers(db, [{ repo: 'o/r', n: 3 }])).toHaveLength(1);
  });

  it('unclaimedOlderThan returns only answers sent before the cutoff', async () => {
    await setStatus(db, PR, input(), T0);
    await setStatus(db, { repo: 'o/r', n: 6 }, input(), T0);
    await addAnswer(db, PR, answer(), T1);
    await addAnswer(db, { repo: 'o/r', n: 6 }, answer(), T3);
    const got = await unclaimedOlderThan(db, T2);
    expect(got.map((g) => g.record.pr)).toEqual([5]);
  });

  it('serviceClaims drops claims whose record version has since moved', async () => {
    await setStatus(db, PR, input(), T0);
    await setStatus(db, { repo: 'o/r', n: 6 }, input(), T0);
    await addAnswer(db, PR, answer(), T1);
    await addAnswer(db, { repo: 'o/r', n: 6 }, answer(), T1);
    await claim(db, PR, 'service', T2);
    await claim(db, { repo: 'o/r', n: 6 }, 'service', T2);
    expect((await serviceClaims(db)).map((c) => c.record.pr).sort()).toEqual([5, 6]);
    await setStatus(db, PR, input({ ask: 'Next' }), T3);
    expect((await serviceClaims(db)).map((c) => c.record.pr)).toEqual([6]);
  });

  it('serviceClaims leaves out session claims and given-up answers', async () => {
    await setStatus(db, PR, input(), T0);
    await setStatus(db, { repo: 'o/r', n: 6 }, input(), T0);
    await addAnswer(db, PR, answer(), T1);
    await addAnswer(db, { repo: 'o/r', n: 6 }, answer(), T1);
    await claim(db, PR, 'session', T2);
    const mine = await claim(db, { repo: 'o/r', n: 6 }, 'service', T2);
    await giveUp(db, mine.answers.map((a) => a.id), 'h', T3);
    expect(await serviceClaims(db)).toEqual([]);
  });

  it('openWork returns open records, the current version\'s answers and the newest given-up answer', async () => {
    const { record } = await setStatus(db, PR, input(), T0);
    const ended = await setStatus(db, { repo: 'o/r', n: 8 }, input(), T0);
    await endWork(db, ended.record.id, 'closed', T1);
    const first = await addAnswer(db, PR, answer(), T1);
    await claim(db, PR, 'service', T2);
    await giveUp(db, [first.id], 'h', T2);
    await setStatus(db, PR, input({ ask: 'Next' }), T3);
    const second = await addAnswer(db, PR, answer({ version: 2 }), T3);
    const got = await openWork(db);
    expect(got.records.map((r) => r.id)).toEqual([record.id]);
    expect(got.answers.map((a) => a.id).sort()).toEqual([first.id, second.id].sort());
  });
});

describe('endWork', () => {
  it('records how and when the work ended, and logs the gate it was in', async () => {
    const { record } = await setStatus(db, PR, input(), T0);
    await endWork(db, record.id, 'merged', T1);
    const row = await db.prepare('SELECT ended_at, ended_how FROM work WHERE id = ?').bind(record.id).first<{ ended_at: string; ended_how: string }>();
    expect(row).toEqual({ ended_at: T1, ended_how: 'merged' });
    expect(JSON.parse((await logs(db, record.id)).at(-1)!.change)).toMatchObject({ ended: 'merged', gate: 'design' });
  });
});

describe('importWork', () => {
  const imported = {
    issue: 3, pr: 5, hasDesign: false, gate: 'implementation' as const, state: 'working' as const, reached: 'implementation' as const,
    ask: 'Building', questions: [], toTest: null, backReason: null, approved: {}, rounds: { design: 0, implementation: 0, prep: 0 },
    prepSha: null, turnSince: T0, writtenAt: T0, startedAt: T0,
  };

  it('stores the record at version 1', async () => {
    const r = await importWork(db, PR, imported, T1);
    expect(r).toMatchObject({ repo: 'o/r', pr: 5, issue: 3, version: 1, endedAt: null, confirmedAt: null });
    expect(await findWork(db, PR)).toEqual(r);
  });

  it('refuses when a record exists', async () => {
    await setStatus(db, PR, input(), T0);
    await expect(importWork(db, PR, imported, T1)).rejects.toThrow(Refused);
  });
});

describe('the log', () => {
  it('gets one row per write, with the right actor', async () => {
    const { record } = await setStatus(db, PR, input(), T0);
    await confirm(db, PR, T1);
    const a = await addAnswer(db, PR, answer(), T1);
    await claim(db, PR, 'session', T2);
    await unclaim(db, [a.id]);
    await claim(db, PR, 'service', T2);
    await giveUp(db, [a.id], 'h', T3);
    await endWork(db, record.id, 'closed', T3);
    expect((await logs(db, record.id)).map((l) => l.actor)).toEqual(['status', 'status', 'answer', 'claim', 'service', 'claim', 'service', 'service']);
  });

  it('logs an import as the switch-over, and a claim that claimed nothing not at all', async () => {
    const r = await importWork(db, PR, {
      issue: null, pr: 5, hasDesign: true, gate: 'design', state: 'working', reached: 'design', ask: 'x', questions: [], toTest: null,
      backReason: null, approved: {}, rounds: { design: 0, implementation: 0, prep: 0 }, prepSha: null, turnSince: T0, writtenAt: T0, startedAt: T0,
    }, T0);
    await claim(db, PR, 'session', T1);
    expect((await logs(db, r.id)).map((l) => l.actor)).toEqual(['switch-over']);
  });

  it('writes nothing when a write is refused', async () => {
    const { record } = await setStatus(db, PR, input(), T0);
    await expect(addAnswer(db, PR, answer({ version: 9 }), T1)).rejects.toThrow(Refused);
    expect(await logs(db, record.id)).toHaveLength(1);
  });
});
