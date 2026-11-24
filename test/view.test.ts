import { describe, expect, it } from 'vitest';
import type { Facts } from '../src/shared/facts.ts';
import { PICKUP_GRACE_MS, WORKING_STALLS_MS } from '../src/shared/names.ts';
import { buildView, readyToMerge, type BoardView, type CardView } from '../src/shared/view.ts';
import type { AnswerRow, WorkRecord } from '../src/shared/work.ts';
import { NOW, ago, answer, facts, layout, pinnedVerses, record, searchBox, toolsState } from './view-helpers.ts';

const MIN = 60 * 1000;

function view(records: WorkRecord[], answers: AnswerRow[], fs: Facts[], now: Date = NOW): BoardView {
  return buildView(records, answers, fs, [], now);
}

function only(records: WorkRecord[], answers: AnswerRow[], fs: Facts[], now: Date = NOW): CardView {
  const v = view(records, answers, fs, now);
  expect(v.everything).toHaveLength(1);
  return v.everything[0]!;
}

function sectionOf(v: BoardView, key: string): 'waiting' | 'onClaude' | 'quiet' | null {
  if (v.waiting.some((c) => c.key === key)) return 'waiting';
  if (v.onClaude.some((c) => c.key === key)) return 'onClaude';
  if (v.quiet.some((c) => c.key === key)) return 'quiet';
  return null;
}

const looks = (c: CardView) => c.boxes.map((b) => b.look);

describe('the cards sketched in the design', () => {
  it('#626 is ready to merge', () => {
    const v = view([toolsState.record], [], [toolsState.facts]);
    const c = v.waiting[0]!;
    expect(c.key).toBe('acme/torahmap#626');
    expect(c.title).toBe('Tools state');
    expect(c.tag).toBe('ready to merge');
    expect(c.tone).toBe('ready');
    expect(looks(c)).toEqual(['approved', 'approved', 'now']);
    expect(c.links.merge).toBe(toolsState.facts.url);
    expect(c.noteLabel).toBe('What needs changing?');
    expect(c.approval).toBeNull();
    expect(c.turn).toBe('owner');
    expect(c.labels).toEqual({ add: ['gate: prep', 'on sam', 'ready to merge'], remove: [] });
  });

  it('#573 is paused with one question', () => {
    const v = view([pinnedVerses.record], [], [pinnedVerses.facts]);
    const c = v.waiting[0]!;
    expect(c.tag).toBe('1 question');
    expect(c.tone).toBe('owner');
    expect(looks(c)).toEqual(['approved', 'now', 'todo']);
    expect(c.questions).toEqual(pinnedVerses.record.questions.map((q) => ({ ...q, choices: [...q.choices, 'file an issue'] })));
    expect(c.approval).toBeNull();
    expect(c.noteLabel).toBe('Note');
    expect(c.links.merge).toBeNull();
  });

  it('#580 has Design complete, round 2', () => {
    const v = view([searchBox.record], [], [searchBox.facts]);
    const c = v.waiting[0]!;
    expect(c.kind).toBe('issue');
    expect(c.tag).toBe('approve design?');
    expect(looks(c)).toEqual(['now', 'todo', 'todo']);
    expect(c.boxes[0]!.round).toBe(2);
    expect(c.approval).toEqual({ choices: ['approve, build it', 'needs changes'], defaultChoice: 'approve, build it' });
    expect(c.waitingSince).toBe(searchBox.record.turnSince);
  });

  it('offers "file an issue" last on each question, once, and never on an approval', () => {
    const questions = [
      { n: 1, text: 'Colour?', choices: ['red', 'green'], defaultChoice: 'red' },
      { n: 2, text: 'Where?', choices: ['top', 'file an issue', 'bottom'], defaultChoice: 'bottom' },
    ];
    const v = view([{ ...searchBox.record, questions }], [], [searchBox.facts]);
    const c = v.waiting[0]!;
    expect(c.questions.map((q) => q.choices)).toEqual([['red', 'green', 'file an issue'], ['top', 'bottom', 'file an issue']]);
    expect(c.questions.map((q) => q.defaultChoice)).toEqual(['red', 'bottom']);
    expect(c.approval!.choices).not.toContain('file an issue');
  });

  it('#564 is reopened, with Implementation on hold', () => {
    const v = view([layout.record], [], [layout.facts]);
    const c = v.onClaude[0]!;
    expect(c.tag).toBe('working');
    expect(c.tone).toBe('claude');
    expect(looks(c)).toEqual(['now', 'on-hold', 'todo']);
    expect(c.boxes[0]!.round).toBe(2);
    expect(c.backReason).toBe("the grid can't hold long titles");
    expect(c.turn).toBe('claude');
  });
});

describe('readyToMerge', () => {
  const r = record({ gate: 'prep', state: 'complete', reached: 'prep', prepSha: 'head1', approved: { design: ago(9), implementation: ago(9) } });
  const reason = (over: Partial<Facts>, rec: WorkRecord = r) => {
    const res = readyToMerge(rec, facts(over));
    return res.ready ? 'ready' : res.reason;
  };

  it('needs a PR', () => {
    expect(readyToMerge(record({ pr: null, issue: 5 }), facts({ kind: 'issue' }))).toEqual({ ready: false, reason: 'no PR', waiting: false });
    expect(readyToMerge(r, undefined)).toEqual({ ready: false, reason: 'no PR', waiting: false });
  });
  it('gives each reason, in order', () => {
    expect(reason({ isDraft: true, mergeState: 'DIRTY' })).toBe('draft');
    expect(reason({ stackedOn: 12, stackedOnOpen: true, headSha: 'other' })).toBe('after #12');
    expect(reason({ stackedOn: 12, stackedOnOpen: false })).toBe('ready');
    expect(reason({ headSha: 'other', mergeState: 'DIRTY' })).toBe('commits since prep');
    expect(reason({ mergeState: 'DIRTY', checks: 'FAILURE' })).toBe('conflicts');
    expect(reason({ mergeState: 'BEHIND' })).toBe('rebase first');
    expect(reason({ behindBase: true, checks: 'FAILURE' })).toBe('rebase first');
    expect(reason({ mergeState: 'UNSTABLE' })).toBe('checks failing');
    expect(reason({ checks: 'FAILURE' })).toBe('checks failing');
    expect(reason({ checks: 'ERROR' })).toBe('checks failing');
    expect(reason({ checks: 'PENDING', mergeState: 'UNKNOWN' })).toBe('checks running');
    expect(reason({ checks: 'EXPECTED' })).toBe('checks running');
    expect(reason({ mergeState: 'UNKNOWN' })).toBe('GitHub checking');
    expect(reason({ mergeState: 'BLOCKED', reviewDecision: null })).toBe('blocked by GitHub');
  });
  it('treats clean and hooks as ready', () => {
    expect(reason({ mergeState: 'CLEAN' })).toBe('ready');
    expect(reason({ mergeState: 'HAS_HOOKS' })).toBe('ready');
  });
  it('treats blocked for a required review, with checks passed or none, as ready', () => {
    expect(reason({ mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', checks: 'SUCCESS' })).toBe('ready');
    expect(reason({ mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', checks: null })).toBe('ready');
  });
  it('says checks failing when blocked for review with failing checks', () => {
    expect(reason({ mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', checks: 'FAILURE' })).toBe('checks failing');
  });
  it('says GitHub is blocking when changes were requested', () => {
    expect(reason({ mergeState: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED', checks: 'SUCCESS' })).toBe('blocked by GitHub');
  });
});

describe('boxes', () => {
  it('has no design box without a design step', () => {
    const c = only([record({ hasDesign: false, approved: {} })], [], [facts()]);
    expect(c.boxes.map((b) => b.gate)).toEqual(['implementation', 'prep']);
    expect(looks(c)).toEqual(['now', 'todo']);
  });

  it('shows prep complete and not mergeable as blocked, with the reason', () => {
    const r = { ...toolsState.record };
    const f = { ...toolsState.facts, mergeState: 'DIRTY' };
    const c = only([r], [], [f]);
    expect(c.boxes[2]!.look).toBe('now');
    expect(c.tag).toBe("can't merge: conflicts");
    expect(c.tone).toBe('blocked');
    expect(c.links.merge).toBeNull();
    expect(c.labels.add).not.toContain('ready to merge');
  });

  it('shows prep complete in grey, not red, while GitHub is still checking', () => {
    const c = only([{ ...toolsState.record }], [], [{ ...toolsState.facts, checks: 'PENDING' }]);
    expect(c.tag).toBe("can't merge: checks running");
    expect(c.tone).toBe('nobody');
  });

  it('carries the owner\'s approval in the answer it shows as sent', () => {
    const r = record({ gate: 'implementation', state: 'complete', toTest: 'try it', approved: { design: ago(900), implementation: ago(1) }, rounds: { design: 1, implementation: 1, prep: 0 } });
    const c = only([r], [answer({ approval: 'looks good, prep for merge', at: ago(1) })], [facts()]);
    expect(c.lastAnswer?.approval).toBe('looks good, prep for merge');
  });

  it('shows the current gate approved once the owner approved it and Claude has not moved on', () => {
    const r = record({ gate: 'implementation', state: 'complete', toTest: 'try it', approved: { design: ago(900), implementation: ago(1) }, rounds: { design: 1, implementation: 1, prep: 0 } });
    const a = answer({ approval: 'looks good, prep for merge', at: ago(1) });
    const c = only([r], [a], [facts()]);
    expect(looks(c)).toEqual(['approved', 'approved', 'now']);
    expect(c.tag).toBe('sent');
    expect(c.tone).toBe('claude');
    expect(c.approval).toBeNull();
    expect(c.turn).toBe('claude');
  });

  it('gives the turn back to the owner once the answer to an approval is not picked up', () => {
    const r = record({ gate: 'implementation', state: 'complete', toTest: 'try it', approved: { design: ago(900), implementation: ago(20) }, rounds: { design: 1, implementation: 1, prep: 0 } });
    const c = only([r], [answer({ approval: 'looks good, prep for merge', at: ago(20) })], [facts()]);
    expect(c.answerState).toBe('not-picked-up');
    expect(looks(c)).toEqual(['approved', 'approved', 'now']);
    expect(c.turn).toBe('owner');
    expect(c.tone).toBe('owner');
  });

  it('marks the gate the work is at, and none when the owner approved it and has not answered', () => {
    expect(looks(only([layout.record], [], [layout.facts]))).toEqual(['now', 'on-hold', 'todo']);
    const approved = record({ gate: 'implementation', state: 'complete', toTest: 'x', approved: { design: ago(900), implementation: ago(1) } });
    expect(looks(only([approved], [], [facts()]))).toEqual(['approved', 'approved', 'todo']);
  });

  it('shows the round only from 2', () => {
    const one = only([record({ state: 'complete', toTest: 'x', rounds: { design: 1, implementation: 1, prep: 0 } })], [], [facts()]);
    expect(one.boxes[1]!.round).toBeNull();
    const working = only([record({ state: 'working', rounds: { design: 1, implementation: 1, prep: 0 } })], [], [facts()]);
    expect(working.boxes[1]!.round).toBe(2);
  });

  it('counts the questions of a paused gate', () => {
    const qs = [1, 2].map((n) => ({ n, text: `Q${n}?`, choices: ['a', 'b'], defaultChoice: 'a' }));
    const c = only([record({ state: 'paused', questions: qs })], [], [facts()]);
    expect(c.tag).toBe('2 questions');
  });

  it('shows parked in grey', () => {
    const c = only([record({ state: 'parked', ask: 'Waiting on the API' })], [], [facts()]);
    expect(looks(c)).toEqual(['approved', 'now', 'todo']);
    expect(c.tag).toBe('parked');
    expect(c.tone).toBe('nobody');
    expect(c.turn).toBe('nobody');
    expect(c.labels.add).toEqual(['gate: implementation', 'parked']);
  });
});

describe('tags', () => {
  const tag = (over: Partial<WorkRecord>) => only([record(over)], [], [facts()]).tag;
  it('says working at every gate, since the gate line names the gate', () => {
    expect(tag({ gate: 'design', reached: 'design', approved: {} })).toBe('working');
    expect(tag({ gate: 'prep', reached: 'prep', approved: { design: ago(9), implementation: ago(9) } })).toBe('working');
  });
  it('asks for approval of a complete build', () => {
    expect(tag({ state: 'complete', toTest: 'try it' })).toBe('approve build?');
  });
  it('says no status for an open PR with no record', () => {
    const v = view([], [], [facts({ number: 77 })]);
    expect(v.waiting.map((c) => c.tag)).toEqual(['no status']);
    expect(v.waiting[0]!.tone).toBe('owner');
    expect(v.waiting[0]!.version).toBeNull();
    expect(v.waiting[0]!.labels).toEqual({ add: [], remove: [] });
  });
  it('leaves an open issue with no record off the board', () => {
    expect(view([], [], [facts({ number: 78, kind: 'issue' })]).everything).toEqual([]);
  });
});

describe('answer state', () => {
  const paused = record({ state: 'paused', questions: [{ n: 1, text: 'Q?', choices: ['a', 'b'], defaultChoice: 'a' }], turnSince: ago(300) });
  const state = (answers: AnswerRow[], r: WorkRecord = paused) => only([r], answers, [facts()]);

  it('is waiting for pickup while an answer is new', () => {
    const c = state([answer({ at: ago(5) })]);
    expect(c.answerState).toBe('awaiting-pickup');
    expect(c.tag).toBe('sent');
    expect(c.tone).toBe('claude');
    expect(c.lastAnswer).toEqual({ at: ago(5), note: 'a note', choices: {}, approval: null });
  });

  it('is not picked up once the grace period has passed', () => {
    const at = new Date(NOW.getTime() - PICKUP_GRACE_MS).toISOString();
    const c = state([answer({ at })]);
    expect(c.answerState).toBe('not-picked-up');
    expect(c.tag).toBe('sent, not picked up');
    expect(c.tone).toBe('owner');
    expect(c.waitingSince).toBe(at);
  });

  it('is the Mac session working when the service claimed every answer', () => {
    const r = record({ state: 'working', ask: 'A Mac session is working on your answers' });
    const c = state([answer({ at: ago(30), claimedAt: ago(25), claimedBy: 'service' })], r);
    expect(c.answerState).toBe('service-working');
    expect(c.tag).toBe('working');
  });

  it('is picked up when a session claimed it, and stalled once the claim is old', () => {
    const r = record({ state: 'working', ask: 'Working on your answers' });
    const fresh = state([answer({ at: ago(30), claimedAt: ago(20), claimedBy: 'session' })], r);
    expect(fresh.answerState).toBe('picked-up');
    expect(fresh.tag).toBe('working');
    const claimedAt = new Date(NOW.getTime() - WORKING_STALLS_MS).toISOString();
    const old = state([answer({ at: ago(70), claimedAt, claimedBy: 'session' })], r);
    expect(old.answerState).toBe('stalled');
    expect(old.tag).toBe('picked up, nothing since');
    expect(old.waitingSince).toBe(claimedAt);
  });

  it('is waiting for pickup when any answer is unclaimed, even if another was claimed', () => {
    const c = state([answer({ id: 1, at: ago(30), claimedAt: ago(25), claimedBy: 'session' }), answer({ id: 2, at: ago(1) })]);
    expect(c.answerState).toBe('awaiting-pickup');
  });

  it('is gave up when the service gave up on an answer to this version', () => {
    const r = record({ state: 'paused', questions: paused.questions, ask: 'A Mac session gave up on your answers', turnSince: ago(5) });
    const c = state([answer({ at: ago(90), claimedAt: ago(85), claimedBy: 'service', gaveUpAt: ago(5) })], r);
    expect(c.answerState).toBe('gave-up');
    expect(c.tag).toBe('Claude gave up');
    expect(c.waitingSince).toBe(ago(85));
    expect(c.lastAnswer?.at).toBe(ago(90));
  });

  it('shows the given-up answer\'s hint on the card, and keeps the record\'s how-to-test', () => {
    const r = record({ state: 'paused', questions: paused.questions, toTest: 'open the preview', ask: 'A Mac session gave up on your answers', turnSince: ago(5) });
    const c = state([answer({ at: ago(90), claimedAt: ago(85), claimedBy: 'service', gaveUpAt: ago(5), giveUpHint: 'Its output is the newest x.log' })], r);
    expect(c.gaveUpHint).toBe('Its output is the newest x.log');
    expect(c.toTest).toBe('open the preview');
    expect(state([answer({ at: ago(2) })]).gaveUpHint).toBeNull();
  });

  it('says paused, not 0 questions, for a paused gate with no questions, as after a give-up from working', () => {
    expect(state([], record({ state: 'paused', questions: [] })).tag).toBe('paused');
    expect(state([], record({ state: 'paused', questions: paused.questions })).tag).toBe('1 question');
  });

  it('ignores a given-up answer to an older version', () => {
    const c = state([answer({ version: 2, at: ago(900), claimedAt: ago(890), claimedBy: 'service', gaveUpAt: ago(800) })]);
    expect(c.answerState).toBeNull();
    expect(c.lastAnswer).toBeNull();
  });

  it('lets a new answer after a give-up go through the usual states', () => {
    const c = state([
      answer({ id: 1, at: ago(90), claimedAt: ago(85), claimedBy: 'service', gaveUpAt: ago(30) }),
      answer({ id: 2, at: ago(2) }),
    ]);
    expect(c.answerState).toBe('awaiting-pickup');
  });

  it('treats a note sent while Claude is working the same way', () => {
    const r = record({ state: 'working' });
    expect(state([answer({ at: ago(3) })], r).answerState).toBe('awaiting-pickup');
    expect(state([answer({ at: ago(11) })], r).answerState).toBe('not-picked-up');
  });

  it('has no answer state with no answers', () => {
    expect(state([]).answerState).toBeNull();
  });
});

describe('sections', () => {
  it('puts the owner\'s turn with no answer in Waiting on you', () => {
    expect(sectionOf(view([pinnedVerses.record], [], [pinnedVerses.facts]), 'acme/torahmap#573')).toBe('waiting');
  });

  it('moves an answered card to On Claude, and back to Waiting when it is not picked up', () => {
    const r = pinnedVerses.record;
    const f = pinnedVerses.facts;
    expect(sectionOf(view([r], [answer({ workId: r.id, version: r.version, at: ago(3) })], [f]), 'acme/torahmap#573')).toBe('onClaude');
    expect(sectionOf(view([r], [answer({ workId: r.id, version: r.version, at: ago(12) })], [f]), 'acme/torahmap#573')).toBe('waiting');
  });

  it('puts Claude\'s turn in On Claude', () => {
    expect(sectionOf(view([layout.record], [], [layout.facts]), 'acme/torahmap#564')).toBe('onClaude');
  });

  it('puts parked cards in Quiet', () => {
    const parked = record({ id: 1, pr: 1, state: 'parked', ask: 'Waiting on the API' });
    expect(sectionOf(view([parked], [], [facts({ number: 1 })]), 'o/r#1')).toBe('quiet');
  });

  it('hands working cards back to the owner once nothing has been written, confirmed or pushed for two hours', () => {
    const quietFor = (minutes: number) => {
      const r = record({ state: 'working', writtenAt: ago(minutes), confirmedAt: null });
      return view([r], [], [facts({ lastActivityAt: ago(minutes) })]);
    };
    const gone = quietFor(120);
    expect(sectionOf(gone, 'o/r#5')).toBe('waiting');
    expect(gone.waiting[0]).toMatchObject({ tag: 'working, nothing since', tone: 'owner', turn: 'owner', waitingSince: ago(120), sessionGone: true });
    const alive = quietFor(119);
    expect(sectionOf(alive, 'o/r#5')).toBe('onClaude');
    expect(alive.onClaude[0]!.tag).toBe('working');
    expect(alive.onClaude[0]!.sessionGone).toBe(false);
  });

  it('keeps the owner\'s turn in Waiting however long it has waited', () => {
    const r = record({ state: 'paused', questions: pinnedVerses.record.questions, writtenAt: ago(5 * 24 * 60) });
    const v = view([r], [], [facts({ lastActivityAt: ago(5 * 24 * 60) })]);
    expect(sectionOf(v, 'o/r#5')).toBe('waiting');
  });

  it('puts an open PR with no record in Waiting on you', () => {
    expect(sectionOf(view([], [], [facts({ number: 9 })]), 'o/r#9')).toBe('waiting');
  });

  it('orders Waiting oldest first', () => {
    const a = record({ id: 1, pr: 1, state: 'paused', questions: pinnedVerses.record.questions, turnSince: ago(60) });
    const b = record({ id: 2, pr: 2, state: 'complete', toTest: 'x', turnSince: ago(600) });
    const c = record({ id: 3, pr: 3, state: 'paused', questions: pinnedVerses.record.questions, turnSince: ago(300) });
    const v = view([a, b, c], [], [1, 2, 3].map((n) => facts({ number: n })));
    expect(v.waiting.map((x) => x.number)).toEqual([2, 3, 1]);
  });

  it('shows questions only while paused or complete', () => {
    const qs = pinnedVerses.record.questions;
    expect(only([record({ state: 'working', questions: qs })], [], [facts()]).questions).toEqual([]);
    expect(only([record({ state: 'complete', toTest: 'x', questions: qs })], [], [facts()]).questions.map((q) => q.text)).toEqual(qs.map((q) => q.text));
  });
});

describe('everything', () => {
  it('lists every open card by when it started, newest first, using a no-record PR\'s creation time', () => {
    const older = record({ id: 1, pr: 1, startedAt: ago(5000) });
    const newer = record({ id: 2, pr: 2, startedAt: ago(1000) });
    const v = view([older, newer], [], [facts({ number: 1 }), facts({ number: 2 }), facts({ number: 3, createdAt: ago(3000) })]);
    expect(v.everything.map((c) => c.number)).toEqual([2, 3, 1]);
  });

  it('keeps a card in place when its answer state changes', () => {
    const qs = pinnedVerses.record.questions;
    const rs = [1, 2, 3].map((n) => record({ id: n, pr: n, state: 'paused', questions: qs, startedAt: ago(n * 1000) }));
    const fs = [1, 2, 3].map((n) => facts({ number: n }));
    const before = view(rs, [], fs);
    const after = view(rs, [answer({ workId: 2, version: 3, at: ago(1) })], fs);
    expect(sectionOf(before, 'o/r#2')).toBe('waiting');
    expect(sectionOf(after, 'o/r#2')).toBe('onClaude');
    expect(after.everything.map((c) => c.number)).toEqual(before.everything.map((c) => c.number));
  });
});

describe('records closing', () => {
  it('leaves out a record whose PR merged or closed', () => {
    expect(view([record()], [], [facts({ merged: true, closedAt: ago(5) })]).everything).toEqual([]);
    expect(view([record()], [], [facts({ closedAt: ago(5) })]).everything).toEqual([]);
  });
  it('leaves out a record whose issue closed with no PR', () => {
    expect(view([searchBox.record], [], [{ ...searchBox.facts, closedAt: ago(5) }]).everything).toEqual([]);
  });
  it('keeps a record whose issue closed while its PR is open', () => {
    const r = record({ issue: 4, pr: 5 });
    expect(view([r], [], [facts(), facts({ number: 4, kind: 'issue', closedAt: ago(5) })]).everything).toHaveLength(1);
  });
});

describe('links and labels', () => {
  it('links the issue and the preview', () => {
    const r = record({ issue: 4, pr: 5 });
    const c = only([r], [], [facts({ previewUrl: 'https://p.example', screenshots: ['https://s.example/1.png'] }), facts({ number: 4, kind: 'issue' })]);
    expect(c.links).toEqual({ pr: 'https://github.com/o/r/pull/5', issue: 'https://github.com/o/r/issues/4', preview: 'https://p.example', merge: null });
    expect(c.screenshots).toEqual(['https://s.example/1.png']);
  });
  it('links the issue a PR names when the record has none', () => {
    const c = only([record()], [], [facts({ linkedIssue: 8 })]);
    expect(c.links.issue).toBe('https://github.com/o/r/issues/8');
  });
  it('removes labels the card should no longer carry, and leaves the rest', () => {
    const c = only([record()], [], [facts({ labels: ['on sam', 'gate: design', 'in-progress', 'bug'] })]);
    expect(c.labels).toEqual({ add: ['gate: implementation'], remove: ['on sam', 'gate: design'] });
  });
});

describe('the board', () => {
  it('passes errors through and stamps the time', () => {
    const v = buildView([], [], [], ['GitHub was slow'], NOW);
    expect(v.errors).toEqual(['GitHub was slow']);
    expect(v.generatedAt).toBe(NOW.toISOString());
  });
  it('starts the card with the record and the facts', () => {
    const c = only([record({ ask: 'Building it', toTest: null })], [], [facts({ title: 'A title' })]);
    expect(c).toMatchObject({ repo: 'o/r', number: 5, kind: 'pr', title: 'A title', version: 3, ask: 'Building it', startedAt: record().startedAt });
  });
  it('waits on the stall time, not before', () => {
    const r = record({ state: 'working' });
    const claimedAt = new Date(NOW.getTime() - WORKING_STALLS_MS + MIN).toISOString();
    expect(only([r], [answer({ claimedAt, claimedBy: 'session' })], [facts()]).answerState).toBe('picked-up');
  });
});
