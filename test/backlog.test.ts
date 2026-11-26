// The backlog on the board: a proposal from "Find some more" to done, the picked-up issues, and what the page is sent.
import { beforeEach, describe, expect, it } from 'vitest';
import { parseItem } from '../src/shared/backlog.ts';
import { buildBacklog } from '../src/shared/backlog-view.ts';
import type { Facts } from '../src/shared/facts.ts';
import { Refused } from '../src/shared/work.ts';
import type { Env } from '../src/worker/access.ts';
import { handleApi, type ApiDeps, type BoardPage } from '../src/worker/api.ts';
import { addPickup, askProposal, openPickups, skipsFor } from '../src/worker/backlog-store.ts';
import { setStatus, type Db } from '../src/worker/store.ts';
import { sqliteDb } from './sqlite-d1.ts';
import { NOW, ago, facts, record } from './view-helpers.ts';

const ORIGIN = 'https://board.example';
const NOW_ISO = NOW.toISOString();

interface Harness { db: Db; env: Env; deps: ApiDeps; items: Facts[]; issues: { repo: string; issues: { number: number; labels: string[] }[]; complete: boolean }[] }

function harness(): Harness {
  const db = sqliteDb();
  const h: Harness = { db, env: { DB: db, GITHUB_TOKEN: 't' } as Env, items: [], issues: [], deps: undefined as never };
  h.deps = {
    now: () => NOW,
    facts: async () => ({ facts: h.items, errors: [], fromCache: false }),
    setLabels: async () => undefined,
    waitUntil: () => undefined,
    backlogIssues: async (_env, repos) => ({ repos: h.issues.filter((i) => repos.includes(i.repo)), errors: [] }),
  };
  return h;
}

async function call(h: Harness, who: 'owner' | 'claude', path: string, body?: unknown) {
  const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    if (who === 'owner') (init.headers as Record<string, string>).Origin = ORIGIN;
    init.body = JSON.stringify(body);
  }
  const res = await handleApi(new Request(`${ORIGIN}${path}`, init), h.env, who, h.deps);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const issue = (n: number, over: Partial<Facts> = {}) => facts({ repo: 'o/r', number: n, kind: 'issue', title: `Issue ${n}`, ...over });

async function look(h: Harness, repos = ['o/r'], running = 1) {
  expect((await call(h, 'claude', '/api/service-look', { running, max: 4, repos })).status).toBe(200);
}

/** A proposal for o/r, claimed by the service and written by its session. */
async function written(h: Harness, items = [{ issue: 25, suggestion: 'pick up', reason: 'small' }, { issue: 11, suggestion: 'close', reason: 'done by #20' }]) {
  await look(h);
  const asked = await call(h, 'owner', '/api/find-more', { repo: 'o/r' });
  expect(asked.status).toBe(200);
  const id = (asked.body.proposal as { id: number }).id;
  expect((await call(h, 'claude', '/api/proposal-claim', { id })).status).toBe(200);
  h.items = [issue(25), issue(11), issue(3)];
  const w = await call(h, 'claude', '/api/proposal-write', { repo: 'o/r', items });
  expect(w.status).toBe(200);
  return id;
}

describe('parseItem', () => {
  it('reads "#N | choice | reason", keeping bars inside the reason', () => {
    expect(parseItem('#25 | pick up | small | and close to #4')).toEqual({ issue: 25, suggestion: 'pick up', reason: 'small | and close to #4' });
  });
  it('reads an issue waiting on other work', () => {
    expect(parseItem('#7 | waiting | waiting on #12')).toEqual({ issue: 7, suggestion: 'waiting', reason: 'waiting on #12' });
  });
  it.each(['25 pick up', '#x | pick up | r', '#2 | maybe | r', '#2 | close | '])('refuses %s', (t) => {
    expect(() => parseItem(t)).toThrow(Refused);
  });
});

describe('a proposal, end to end', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('refuses "Find some more" for a repo the Mac service does not serve, and a second one while one is under way', async () => {
    expect((await call(h, 'owner', '/api/find-more', { repo: 'o/r' })).status).toBe(409);
    await look(h);
    expect((await call(h, 'owner', '/api/find-more', { repo: 'o/r' })).status).toBe(200);
    const again = await call(h, 'owner', '/api/find-more', { repo: 'o/r' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already has a proposal under way/);
  });

  it('is claimed once, tells the session what to leave out, and takes its list with titles from GitHub', async () => {
    await look(h);
    const id = ((await call(h, 'owner', '/api/find-more', { repo: 'o/r' })).body.proposal as { id: number }).id;
    await addPickup(h.db, 'o/r', 9, null, NOW_ISO);
    const claimed = await call(h, 'claude', '/api/proposal-claim', { id });
    expect(claimed.body.skip).toEqual([{ issue: 9, why: 'it is already picked up and waiting for a session' }]);
    expect((await call(h, 'claude', '/api/proposal-claim', { id })).status).toBe(409);

    h.items = [issue(25), issue(11)];
    const w = await call(h, 'claude', '/api/proposal-write', { repo: 'o/r', items: [{ issue: 25, suggestion: 'pick up', reason: 'small' }] });
    expect((w.body.proposal as { items: unknown }).items).toEqual([{ issue: 25, title: 'Issue 25', suggestion: 'pick up', reason: 'small' }]);
  });

  it('refuses a list naming a PR, a closed issue, too many picks, or an issue twice', async () => {
    await look(h);
    const id = ((await call(h, 'owner', '/api/find-more', { repo: 'o/r' })).body.proposal as { id: number }).id;
    await call(h, 'claude', '/api/proposal-claim', { id });
    h.items = [facts({ repo: 'o/r', number: 7 }), issue(8, { closedAt: ago(5) }), ...[1, 2, 3, 4, 5, 6, 9, 10, 11].map((n) => issue(n))];
    const write = (items: unknown[]) => call(h, 'claude', '/api/proposal-write', { repo: 'o/r', items });
    expect((await write([{ issue: 7, suggestion: 'pick up', reason: 'r' }])).body.error).toMatch(/is a pull request/);
    expect((await write([{ issue: 8, suggestion: 'pick up', reason: 'r' }])).body.error).toMatch(/already closed/);
    expect((await write([1, 2, 3, 4, 5, 6, 9, 10, 11].map((n) => ({ issue: n, suggestion: 'pick up', reason: 'r' })))).body.error).toMatch(/at most 8/);
    expect((await write([{ issue: 1, suggestion: 'waiting', reason: 'after the parser lands' }])).body.error).toMatch(/must name what it waits for/);
    expect((await write([{ issue: 1, suggestion: 'close', reason: 'r' }, { issue: 1, suggestion: 'later', reason: 'r' }])).body.error).toMatch(/twice/);
  });

  it('takes one answer with a choice for every issue, then is carried out once and finished', async () => {
    const id = await written(h);
    expect((await call(h, 'owner', '/api/proposal-answer', { id, answers: { 25: 'pick up' }, note: '' })).body.error).toMatch(/#11 has no answer/);
    expect((await call(h, 'owner', '/api/proposal-answer', { id, answers: { 25: 'pick up', 11: 'maybe' }, note: '' })).status).toBe(409);
    expect((await call(h, 'owner', '/api/proposal-answer', { id, answers: { 25: 'pick up', 11: 'later' }, note: '' })).status).toBe(200);
    expect((await call(h, 'owner', '/api/proposal-answer', { id, answers: { 25: 'pick up', 11: 'later' }, note: '' })).status).toBe(409);

    expect((await call(h, 'claude', '/api/proposal-carry', { id })).status).toBe(200);
    expect((await call(h, 'claude', '/api/proposal-carry', { id })).status).toBe(409);
    expect((await call(h, 'claude', '/api/pickup-add', { repo: 'o/r', number: 25, proposalId: id })).status).toBe(200);
    expect((await call(h, 'claude', '/api/proposal-done', { id })).status).toBe(200);

    const work = await call(h, 'claude', '/api/backlog-work');
    // The finished proposal is still read, since the open pick-up's reason is on it.
    expect((work.body.proposals as { id: number; doneAt: string | null }[]).map((p) => [p.id, p.doneAt !== null])).toEqual([[id, true]]);
    expect((work.body.pickups as { issue: number }[]).map((u) => u.issue)).toEqual([25]);
    // The "later" keeps #11 out of the next proposal.
    expect(await skipsFor(h.db, 'o/r', NOW_ISO)).toEqual([
      { issue: 11, why: expect.stringMatching(/said "later" to it/) },
      { issue: 25, why: 'it is already picked up and waiting for a session' },
    ]);
  });

  it('lists waiting issues without asking about them or counting them as picks, and shows them after the answer', async () => {
    const picks = [1, 2, 3, 4, 5, 6, 9, 10].map((n) => ({ issue: n, suggestion: 'pick up', reason: 'r' }));
    await look(h);
    const id = ((await call(h, 'owner', '/api/find-more', { repo: 'o/r' })).body.proposal as { id: number }).id;
    await call(h, 'claude', '/api/proposal-claim', { id });
    h.items = [...[1, 2, 3, 4, 5, 6, 9, 10, 12].map((n) => issue(n))];
    const w = await call(h, 'claude', '/api/proposal-write', { repo: 'o/r', items: [...picks, { issue: 12, suggestion: 'waiting', reason: 'waiting on #40' }] });
    expect(w.status).toBe(200);

    h.issues = [{ repo: 'o/r', complete: true, issues: [1, 2, 3, 4, 5, 6, 9, 10, 12].map((number) => ({ number, labels: [] })) }];
    const board = (await call(h, 'owner', '/api/board')).body as unknown as BoardPage;
    expect(board.backlog.proposals[0]!.questions.map((q) => q.issue)).toEqual([1, 2, 3, 4, 5, 6, 9, 10]);
    expect(board.backlog.proposals[0]!.tag).toBe('8 questions');
    expect(board.backlog.waiting).toEqual([{ key: 'o/r#12 waiting', repo: 'o/r', issue: 12, title: 'Issue 12', url: 'https://github.com/o/r/issues/12', reason: 'waiting on #40' }]);

    const answers = Object.fromEntries(picks.map((p) => [p.issue, 'later']));
    expect((await call(h, 'owner', '/api/proposal-answer', { id, answers, note: '' })).status).toBe(200);
    await call(h, 'claude', '/api/proposal-carry', { id });
    await call(h, 'claude', '/api/proposal-done', { id });
    expect(((await call(h, 'owner', '/api/board')).body as unknown as BoardPage).backlog.waiting.map((x) => x.issue)).toEqual([12]);

    // Once the issue is closed it is no longer waiting.
    h.issues = [{ repo: 'o/r', complete: true, issues: [] }];
    expect(((await call(h, 'owner', '/api/board')).body as unknown as BoardPage).backlog.waiting).toEqual([]);
  });

  it('with a note, waits for the note session, which finishes it by repo or sends back what it could not do', async () => {
    const id = await written(h);
    await call(h, 'owner', '/api/proposal-answer', { id, answers: { 25: 'later', 11: 'close' }, note: 'also #3' });
    await call(h, 'claude', '/api/proposal-carry', { id });
    // Not before every choice is carried out.
    expect((await call(h, 'claude', '/api/proposal-note-started', { id })).status).toBe(409);
    expect((await call(h, 'claude', '/api/proposal-carry-done', { id })).status).toBe(200);
    expect((await call(h, 'claude', '/api/proposal-note-started', { id })).status).toBe(200);
    expect((await call(h, 'claude', '/api/proposal-note-started', { id })).status).toBe(409);
    const done = await call(h, 'claude', '/api/proposal-done', { repo: 'o/r', problem: "#3 doesn't exist" });
    expect(done.body.proposal).toMatchObject({ failure: "#3 doesn't exist" });
    // A failed proposal doesn't hold up the next one.
    expect((await call(h, 'owner', '/api/find-more', { repo: 'o/r' })).status).toBe(200);
  });

  it('keeps a note of only spaces as no note', async () => {
    const id = await written(h);
    const sent = await call(h, 'owner', '/api/proposal-answer', { id, answers: { 25: 'later', 11: 'later' }, note: '  \n ' });
    expect(sent.body.proposal).toMatchObject({ note: '' });
  });

  it('once failed before its list, can be tried again; any failed one can be dismissed', async () => {
    await look(h);
    const id = ((await call(h, 'owner', '/api/find-more', { repo: 'o/r' })).body.proposal as { id: number }).id;
    await call(h, 'claude', '/api/proposal-claim', { id });
    await call(h, 'claude', '/api/proposal-failed', { id, failure: 'the session ended without writing a list' });
    expect((await call(h, 'owner', '/api/proposal-retry', { id })).status).toBe(200);
    expect((await call(h, 'claude', '/api/proposal-claim', { id })).status).toBe(200);
    await call(h, 'claude', '/api/proposal-failed', { id, failure: 'again' });
    expect((await call(h, 'owner', '/api/proposal-dismiss', { id })).status).toBe(200);
    expect((await call(h, 'claude', '/api/backlog-work')).body.proposals).toEqual([]);
  });
});

describe('picked-up issues', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('refuses an issue already picked up or with a record', async () => {
    await addPickup(h.db, 'o/r', 25, null, NOW_ISO);
    await expect(addPickup(h.db, 'o/r', 25, null, NOW_ISO)).rejects.toThrow(/already picked up/);
    h.items = [issue(30)];
    await setStatus(h.db, { repo: 'o/r', n: 30 }, { gate: 'design', state: 'working', ask: '', questions: [], toTest: null, reason: null, noDesign: false, headSha: null, isPr: false, issue: null, replaces: null }, NOW_ISO);
    await expect(addPickup(h.db, 'o/r', 30, null, NOW_ISO)).rejects.toThrow(/already has a record/);
  });

  it('is done once the issue’s first status is written', async () => {
    await addPickup(h.db, 'o/r', 25, null, NOW_ISO);
    await setStatus(h.db, { repo: 'o/r', n: 25 }, { gate: 'design', state: 'working', ask: '', questions: [], toTest: null, reason: null, noDesign: false, headSha: null, isPr: false, issue: null, replaces: null }, NOW_ISO);
    expect(await openPickups(h.db)).toEqual([]);
  });

  it('can be dropped before it starts, then is finished once the service has taken the label off', async () => {
    const u = await addPickup(h.db, 'o/r', 25, null, NOW_ISO);
    expect((await call(h, 'owner', '/api/pickup-drop', { id: u.id })).status).toBe(200);
    expect((await call(h, 'claude', '/api/pickup-claim', { id: u.id })).status).toBe(409);
    expect((await call(h, 'claude', '/api/pickup-done', { id: u.id })).status).toBe(200);
    expect(await openPickups(h.db)).toEqual([]);
  });

  it('once given up on, can be tried again', async () => {
    const u = await addPickup(h.db, 'o/r', 25, null, NOW_ISO);
    await call(h, 'claude', '/api/pickup-claim', { id: u.id });
    expect((await call(h, 'owner', '/api/pickup-drop', { id: u.id })).status).toBe(409);
    await call(h, 'claude', '/api/pickup-failed', { id: u.id, failure: 'no status written' });
    expect((await call(h, 'owner', '/api/pickup-retry', { id: u.id })).status).toBe(200);
    expect((await call(h, 'claude', '/api/pickup-claim', { id: u.id })).status).toBe(200);
  });
});

describe('the board the page reads', () => {
  it('has a line per repo the Mac service serves, the session count, the proposal card and the picked-up issues', async () => {
    const h = harness();
    h.issues = [{ repo: 'o/r', complete: true, issues: [{ number: 25, labels: [] }, { number: 11, labels: [] }, { number: 3, labels: ['in-progress'] }, { number: 4, labels: [] }] }];
    const id = await written(h);
    await look(h, ['o/r'], 3);
    await addPickup(h.db, 'o/r', 4, null, NOW_ISO);
    h.items = [issue(4)];
    const page = (await call(h, 'owner', '/api/board')).body as unknown as BoardPage;
    expect(page.backlog.sessions).toEqual({ running: 3, max: 4, at: NOW_ISO, stale: false });
    // #3 has the in-progress label and #4 is picked up.
    expect(page.backlog.repos).toEqual([{ repo: 'o/r', name: 'r', open: 2, atLeast: false, busy: 'a proposal is waiting for you' }]);
    expect(page.backlog.proposals).toMatchObject([{ id, title: 'Next from the r backlog', tag: '2 questions', section: 'waiting', answerable: true }]);
    expect(page.backlog.proposals[0]!.questions.map((q) => [q.issue, q.defaultChoice])).toEqual([[25, 'pick up'], [11, 'close']]);
    expect(page.backlog.pickups).toMatchObject([{ issue: 4, title: 'Issue 4', tag: 'Picked up, waiting for a free session', section: 'onClaude', canDrop: true }]);
  });

  it('ends a pick-up whose issue closed on GitHub', async () => {
    const h = harness();
    await addPickup(h.db, 'o/r', 4, null, NOW_ISO);
    h.items = [issue(4, { closedAt: ago(1) })];
    const page = (await call(h, 'owner', '/api/board')).body as unknown as BoardPage;
    expect(page.backlog.pickups).toEqual([]);
    expect(await openPickups(h.db)).toEqual([]);
  });
});

describe('buildBacklog', () => {
  it('says what each repo line is waiting on, and that a look gone quiet is stale', async () => {
    const db = sqliteDb();
    const p = await askProposal(db, 'o/r', ago(2));
    const view = buildBacklog({ at: ago(10), running: 0, max: 4, repos: ['o/r', 'o/s'] }, [p], [], [record({ repo: 'o/s', issue: 1, pr: null })], [{ repo: 'o/s', complete: false, issues: [{ number: 1, labels: [] }, { number: 2, labels: [] }] }], [], NOW);
    expect(view.sessions?.stale).toBe(true);
    expect(view.repos).toEqual([
      { repo: 'o/r', name: 'r', open: null, atLeast: false, busy: 'waiting for a free session to look through the backlog…' },
      { repo: 'o/s', name: 's', open: 1, atLeast: true, busy: null },
    ]);
    expect(view.proposals).toEqual([]);
  });
});
