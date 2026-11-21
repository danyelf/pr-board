import { describe, expect, it } from 'vitest';
import { describe as describeAnswers } from '../cli/answers.ts';
import type { Gh } from '../cli/gh.ts';
import { main } from '../cli/watch-answers.ts';
import type { AnswerRow, WorkRecord } from '../src/shared/work.ts';

const POLL = 60_000;
const COLLECT = 60_000;
const MAX_BACKOFF = 300_000;

function record(over: Partial<WorkRecord> = {}): WorkRecord {
  return {
    id: 1, repo: 'acme/x', issue: null, pr: 5, hasDesign: true, gate: 'implementation', state: 'complete', reached: 'implementation',
    ask: 'Look it over', questions: [{ n: 1, text: 'Colour?', choices: ['leave', 'change'], defaultChoice: 'leave' }], toTest: 'open it',
    backReason: null, approved: {}, rounds: { design: 1, implementation: 1, prep: 0 }, prepSha: null, version: 3,
    turnSince: '2026-11-08T10:00:00Z', writtenAt: '2026-11-08T10:00:00Z', confirmedAt: null, startedAt: '2026-11-01T00:00:00Z', endedAt: null, endedHow: null,
    ...over,
  };
}

function answer(over: Partial<AnswerRow> = {}): AnswerRow {
  return {
    id: 10, workId: 1, version: 3, at: '2026-11-08T10:05:00Z', choices: { '1': 'change' }, approval: 'looks good, prep for merge', note: 'tint is strong\nbut fine',
    claimedAt: null, claimedBy: null, stateBefore: 'complete', gaveUpAt: null, giveUpHint: null, ...over,
  };
}

/** The board as the watcher sees it: records with answers, each answer claimed once. */
class Board {
  records: WorkRecord[] = [record()];
  answers: AnswerRow[] = [];
  /** Answers another session claims just before this one does. */
  lostRace = new Set<number>();
  failUnclaimed = 0;
  sent: { method: string; path: string; body: unknown }[] = [];

  find(repo: string, n: number): WorkRecord | undefined {
    return this.records.find((r) => r.repo === repo && (r.pr === n || r.issue === n) && r.endedAt === null);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.sent.push({ method: init?.method ?? 'GET', path, body });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/unclaimed') {
      if (this.failUnclaimed > 0) { this.failUnclaimed--; return reply(502, { error: 'Bad Gateway' }); }
      const refs = (body!.refs as { repo: string; number: number }[]);
      const found = new Map<number, { record: WorkRecord; answers: AnswerRow[] }>();
      for (const ref of refs) {
        const rec = this.find(ref.repo, ref.number);
        if (!rec) continue;
        const open = this.answers.filter((a) => a.workId === rec.id && a.claimedAt === null);
        if (open.length > 0) found.set(rec.id, { record: rec, answers: open });
      }
      return reply(200, [...found.values()]);
    }
    if (url.pathname === '/api/claim') {
      const rec = this.find(body!.repo as string, body!.number as number);
      // The real board refuses a claim on an item with no open record.
      if (!rec) return reply(409, { error: 'not open on the board' });
      const mine = this.answers.filter((a) => a.workId === rec.id && a.claimedAt === null && !this.lostRace.has(a.id));
      for (const a of this.answers) if (this.lostRace.has(a.id)) a.claimedAt = 'other';
      for (const a of mine) { a.claimedAt = 'now'; a.claimedBy = body!.by as 'session'; }
      return reply(200, { record: rec, answers: mine });
    }
    if (url.pathname === '/api/work') {
      const rec = this.find(url.searchParams.get('repo')!, Number(url.searchParams.get('number')));
      if (!rec) return reply(404, { error: 'not open on the board' });
      return reply(200, { record: rec, answers: this.answers.filter((a) => a.workId === rec.id) });
    }
    return reply(404, { error: 'Not found' });
  };
}

class World {
  board = new Board();
  me = 'robot';
  failRepoLookups = 0;
  gh: Gh = async (args) => {
    const line = args.join(' ');
    if (line === 'api user -q .login') return `${this.me}\n`;
    if (line === 'repo view --json nameWithOwner -q .nameWithOwner') {
      if (this.failRepoLookups > 0) { this.failRepoLookups--; throw new Error('gh: could not reach GitHub'); }
      return 'acme/x\n';
    }
    throw new Error(`unexpected gh call: ${line}`);
  };
}

async function watch(world: World, argv: string[], onSleep: (count: number, ms: number) => void = () => {}) {
  const sleeps: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    if (sleeps.length > 500) throw new Error('the watcher never stopped');
    onSleep(sleeps.length, ms);
  };
  const board = { fetch: world.board.fetch, readFile: () => JSON.stringify({ clientId: 'id', clientSecret: 'secret' }), env: {}, home: '/home/x' };
  const code = await main(argv, { gh: world.gh, board, sleep, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, sleeps, out: out.join('\n'), err: err.join('\n') };
}

describe('watch-answers', () => {
  it('checks once a minute until an answer comes, waits a minute more, claims it for the session and prints it', async () => {
    const w = new World();
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 3) w.board.answers.push(answer()); });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([POLL, POLL, POLL, COLLECT]);
    expect(w.board.sent.find((s) => s.path === '/api/claim')?.body).toEqual({ repo: 'acme/x', number: 5, by: 'session' });
    expect(w.board.answers[0]!.claimedBy).toBe('session');
    expect(r.out).toContain('acme/x#5');
    expect(r.out).toContain('1. Colour? → change');
    expect(r.out).toContain('looks good, prep for merge');
    expect(r.out).toContain('Note: tint is strong\n    but fine');
  });

  it("doesn't exit when the claim comes back with no answers because another session got there first", async () => {
    const w = new World();
    w.board.answers.push(answer());
    w.board.lostRace.add(10);
    let fresh = false;
    const r = await watch(w, ['acme/x#5'], (n) => {
      if (n === 4 && !fresh) { fresh = true; w.board.answers.push(answer({ id: 11, choices: { '1': 'leave' }, approval: null, note: '' })); }
    });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([COLLECT, POLL, POLL, POLL, COLLECT]);
    expect(r.out).toContain('1. Colour? → leave');
    expect(r.out).not.toContain('→ change');
  });

  it('keeps going through errors, waiting longer each time up to 5 minutes, and never exits because of them', async () => {
    const w = new World();
    w.board.answers.push(answer());
    w.board.failUnclaimed = 6;
    const r = await watch(w, ['acme/x#5']);
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([120_000, 240_000, MAX_BACKOFF, MAX_BACKOFF, MAX_BACKOFF, MAX_BACKOFF, COLLECT]);
    expect(r.err).toContain('502');
    expect(r.err.split('\n').filter((l) => l.includes('trying again')).length).toBe(6);
  });

  it('goes back to the ordinary wait once a check works again', async () => {
    const w = new World();
    w.board.failUnclaimed = 2;
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 4) w.board.answers.push(answer()); });
    expect(r.sleeps).toEqual([120_000, 240_000, POLL, POLL, COLLECT]);
  });

  it('finds answers for an issue number after a PR was attached, since the board resolves it', async () => {
    const w = new World();
    w.board.records = [record({ issue: 3, pr: 9 })];
    w.board.answers.push(answer());
    const r = await watch(w, ['acme/x#3']);
    expect(r.code).toBe(0);
    expect(w.board.sent.find((s) => s.path === '/api/unclaimed')?.body).toEqual({ refs: [{ repo: 'acme/x', number: 3 }] });
    expect(w.board.sent.find((s) => s.path === '/api/claim')?.body).toEqual({ repo: 'acme/x', number: 3, by: 'session' });
    expect(r.out).toContain('1. Colour? → change');
  });

  it('stops, saying so, once every watched record has ended', async () => {
    const w = new World();
    w.board.records.push(record({ id: 2, repo: 'acme/y', pr: 7 }));
    const r = await watch(w, ['acme/x#5', 'acme/y#7'], (n) => {
      if (n === 1) w.board.records[0]!.endedAt = '2026-11-09T00:00:00Z';
      if (n === 2) w.board.records[1]!.endedAt = '2026-11-09T00:00:00Z';
    });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([POLL, POLL]);
    expect(r.out).toContain('acme/x#5 has ended on the board; no longer watching it.');
    expect(r.out).toContain('nothing left to watch');
  });

  it('prints the answers it claimed when another watched item has ended, and stops watching that one', async () => {
    const w = new World();
    w.board.records.push(record({ id: 2, repo: 'acme/y', pr: 7, endedAt: '2026-11-09T00:00:00Z' }));
    w.board.answers.push(answer());
    const r = await watch(w, ['acme/x#5', 'acme/y#7']);
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([COLLECT]);
    expect(w.board.answers[0]!.claimedBy).toBe('session');
    expect(r.out).toContain('acme/y#7 has ended on the board');
    expect(r.out).toContain('1. Colour? → change');
  });

  it("works out a #N reference's repo inside the loop, so a passing failure is retried rather than fatal", async () => {
    const w = new World();
    w.board.answers.push(answer());
    w.failRepoLookups = 2;
    const r = await watch(w, ['#5']);
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([120_000, 240_000, COLLECT]);
    expect(r.err).toContain('could not reach GitHub');
    expect(r.out).toContain('acme/x#5');
  });

  it("refuses to start under the owner's own account, whose gh would look like nobody had picked the review up", async () => {
    const w = new World();
    w.me = 'sam-gh';
    const r = await watch(w, ['acme/x#5']);
    expect(r.code).toBe(1);
    expect(r.sleeps).toEqual([]);
    expect(r.err).toContain("gh is signed in as sam-gh, the board's owner");
  });

  it('stops at once with the usage when it is given nothing to watch or a reference it cannot read', async () => {
    const w = new World();
    for (const argv of [[], ['nonsense']]) {
      const r = await watch(w, argv);
      expect(r.code).toBe(1);
      expect(r.sleeps).toEqual([]);
    }
    expect((await watch(w, [])).err).toContain('Usage: watch-answers');
  });
});

describe('describe', () => {
  it('gives the item, each question with its choice, the approval and the indented note', () => {
    const text = describeAnswers(record(), [answer()]);
    expect(text).toBe([
      'acme/x#5',
      '  1. Colour? → change',
      '  Approval: looks good, prep for merge',
      '  Note: tint is strong',
      '    but fine',
    ].join('\n'));
  });

  it('names the issue when the work has no PR yet, and skips questions that got no choice', () => {
    const text = describeAnswers(record({ pr: null, issue: 3 }), [answer({ choices: {}, approval: null, note: '' })]);
    expect(text).toBe('acme/x#3');
  });
});
