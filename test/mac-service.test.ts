import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describe as describeAnswers } from '../cli/answers.ts';
import type { Gh } from '../cli/gh.ts';
import { loadConfig, main, runningSessions, type ServiceDeps, type SpawnOptions } from '../cli/mac-service.ts';
import { GAVE_UP_ASK, SERVICE_WORKING_ASK, WORKING_ASK } from '../src/shared/names.ts';
import type { AnswerRow, State, WorkRecord } from '../src/shared/work.ts';
import type { Pickup, Proposal, Skip } from '../src/shared/backlog.ts';

const HOME = '/home/sam';
const CONFIG_PATH = `${HOME}/.pr-board/service.json`;
const TOKEN_PATH = `${HOME}/.config/claude-github/token`;
const BOARD_TOKEN_PATH = `${HOME}/.config/pr-board/access-token.json`;
const CLAUDE = `${HOME}/.local/bin/claude`;
const POLL = 60_000;
const MIN = 60_000;
const START = Date.parse('2026-11-08T10:30:00.000Z');

interface Item { branch: string; headRepo: string }
interface Started { pid: number; cmd: string; args: string[]; opts: SpawnOptions; startedAt: number; alive: boolean; finish: (code: number) => void }
interface Sent { method: string; path: string; body: Record<string, unknown> | undefined }
type Found = { record: WorkRecord; answers: AnswerRow[] };

function proposalRow(over: Partial<Proposal> & Pick<Proposal, 'id' | 'repo'>): Proposal {
  return {
    askedAt: '2026-11-08T10:00:00.000Z', startedAt: null, writtenAt: null, items: null, answeredAt: null, answers: null, note: null,
    carriedAt: null, noteStartedAt: null, doneAt: null, failedAt: null, failure: null, ...over,
  };
}

function pickupRow(over: Partial<Pickup> & Pick<Pickup, 'id' | 'repo' | 'issue'>): Pickup {
  return { proposalId: null, askedAt: '2026-11-08T10:00:00.000Z', startedAt: null, doneAt: null, failedAt: null, failure: null, droppedAt: null, ...over };
}

/** ps's elapsed time for ms: mm:ss, hh:mm:ss or d-hh:mm:ss. */
function etime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  const [d, h, m, sec] = [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60];
  return d > 0 ? `${d}-${two(h)}:${two(m)}:${two(sec)}` : h > 0 ? `${two(h)}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** The board as the service sees it: records, answers, and claims kept the way the store keeps them. */
class Board {
  records: WorkRecord[] = [];
  answers: AnswerRow[] = [];
  /** The record's version when each answer was claimed: the claim is live while the record is still at it. */
  claimedVersion = new Map<number, number>();
  /** What the record was before a claim set it to working, to put back on an unclaim. */
  before = new Map<number, { state: State; ask: string }>();
  sent: Sent[] = [];
  /** Routes that answer 502 this many more times. */
  fail = new Map<string, number>();
  /** Routes whose change the board makes, but whose reply never arrives. */
  lostReply = new Set<string>();
  /** Answers a session's watcher claims just before the service does. */
  lostRace = new Set<number>();
  nextId = 100;
  proposals: Proposal[] = [];
  pickups: Pickup[] = [];
  /** What a proposal claim tells the session to leave out. */
  skip: Skip[] = [];
  looks: { running: number; max: number; repos: string[] }[] = [];

  clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  find(repo: string, n: number): WorkRecord | undefined {
    return this.records.find((r) => r.repo === repo && (r.pr === n || r.issue === n) && r.endedAt === null);
  }

  of(ref: string): WorkRecord {
    const [repo, n] = ref.split('#');
    return this.find(repo!, Number(n))!;
  }

  answer(id: number): AnswerRow {
    return this.answers.find((a) => a.id === id)!;
  }

  isLive(a: AnswerRow, r: WorkRecord): boolean {
    return a.claimedAt !== null && a.gaveUpAt === null && this.claimedVersion.get(a.id) === r.version;
  }

  /** Claims every waiting answer of the record, as the store does; returns the ones this call got. */
  claim(r: WorkRecord, by: 'session' | 'service'): AnswerRow[] {
    const now = new Date(this.clock()).toISOString();
    for (const a of this.answers) {
      if (a.workId === r.id && a.claimedAt === null && this.lostRace.has(a.id)) {
        a.claimedAt = now; a.claimedBy = 'session'; this.claimedVersion.set(a.id, r.version);
      }
    }
    const mine = this.answers.filter((a) => a.workId === r.id && a.claimedAt === null);
    for (const a of mine) {
      a.claimedAt = now; a.claimedBy = by; this.claimedVersion.set(a.id, r.version);
      this.before.set(a.id, { state: r.state, ask: r.ask });
    }
    if (mine.length > 0 && r.state !== 'working') { r.state = 'working'; r.ask = by === 'service' ? SERVICE_WORKING_ASK : WORKING_ASK; }
    return mine;
  }

  /** A session wrote a new status. */
  newStatus(ref: string): void {
    const r = this.of(ref);
    r.version++;
    r.state = 'complete';
    r.ask = 'next look';
  }

  claimsByService(): Found[] {
    return this.group(this.answers.filter((a) => {
      const r = this.records.find((x) => x.id === a.workId)!;
      return r.endedAt === null && a.claimedBy === 'service' && this.isLive(a, r);
    }));
  }

  group(list: AnswerRow[]): Found[] {
    return [...new Set(list.map((a) => a.workId))].map((id) => ({ record: structuredClone(this.records.find((r) => r.id === id)!), answers: structuredClone(list.filter((a) => a.workId === id)) }));
  }

  posts(path?: string): Sent[] {
    return this.sent.filter((s) => s.method === 'POST' && (path === undefined || s.path === path));
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const method = init?.method ?? 'GET';
    this.sent.push({ method, path: url.pathname, body });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const left = this.fail.get(url.pathname) ?? 0;
    if (left > 0) {
      this.fail.set(url.pathname, left - 1);
      return reply(502, { error: 'Bad Gateway' });
    }
    const answer = (data: unknown) => (this.lostReply.has(url.pathname) ? reply(502, { error: 'Bad Gateway' }) : reply(200, data));
    if (method === 'POST' && url.pathname === '/api/unclaimed') {
      const before = this.clock() - (body!.olderThanMs as number);
      return reply(200, this.group(this.answers.filter((a) => {
        const r = this.records.find((x) => x.id === a.workId)!;
        return r.endedAt === null && a.claimedAt === null && Date.parse(a.at) < before && r.state !== 'working';
      })));
    }
    if (method === 'POST' && url.pathname === '/api/claim') {
      const r = this.find(body!.repo as string, body!.number as number);
      if (!r) return reply(409, { error: `${body!.repo}#${body!.number} is not open on the board` });
      const mine = this.claim(r, body!.by as 'service');
      return answer({ record: structuredClone(r), answers: structuredClone(mine) });
    }
    if (method === 'POST' && url.pathname === '/api/unclaim') {
      for (const id of body!.answerIds as number[]) {
        const a = this.answer(id);
        const r = this.records.find((x) => x.id === a.workId)!;
        const was = this.before.get(id)!;
        r.state = was.state; r.ask = was.ask;
        a.claimedAt = null; a.claimedBy = null; this.claimedVersion.delete(id);
      }
      return answer({});
    }
    if (method === 'POST' && url.pathname === '/api/gave-up') {
      for (const id of body!.answerIds as number[]) {
        const a = this.answer(id);
        const r = this.records.find((x) => x.id === a.workId)!;
        if (a.gaveUpAt === null && r.state === 'working') { r.state = 'paused'; r.ask = GAVE_UP_ASK; }
        a.gaveUpAt = new Date(this.clock()).toISOString();
        a.giveUpHint = body!.hint as string;
      }
      return answer({});
    }
    if (method === 'GET' && url.pathname === '/api/service-claims') return reply(200, this.claimsByService());
    if (method === 'GET' && url.pathname === '/api/backlog-work') {
      return reply(200, { proposals: structuredClone(this.proposals.filter((p) => p.doneAt === null)), pickups: structuredClone(this.pickups.filter((u) => u.doneAt === null)) });
    }
    if (method === 'POST' && url.pathname === '/api/service-look') {
      this.looks.push(body as never);
      return reply(200, {});
    }
    const now = new Date(this.clock()).toISOString();
    const proposal = () => this.proposals.find((p) => p.id === body!.id) ?? this.proposals.find((p) => p.repo === body!.repo && p.doneAt === null && p.failedAt === null);
    const pickup = () => this.pickups.find((u) => u.id === body!.id)!;
    const refuse = (why: string) => reply(409, { error: why });
    if (method === 'POST' && url.pathname === '/api/proposal-claim') {
      const p = proposal()!;
      if (p.startedAt !== null) return refuse('taken');
      p.startedAt = now;
      return answer({ proposal: structuredClone(p), skip: this.skip });
    }
    if (method === 'POST' && url.pathname === '/api/proposal-unclaim') { proposal()!.startedAt = null; return answer({}); }
    if (method === 'POST' && url.pathname === '/api/proposal-carry') {
      const p = proposal()!;
      if (p.carriedAt !== null) return refuse('taken');
      p.carriedAt = now;
      return answer({ proposal: structuredClone(p) });
    }
    if (method === 'POST' && url.pathname === '/api/proposal-note-started') { const p = proposal()!; p.noteStartedAt = now; return answer({ proposal: structuredClone(p) }); }
    if (method === 'POST' && url.pathname === '/api/proposal-note-unstarted') { proposal()!.noteStartedAt = null; return answer({}); }
    if (method === 'POST' && url.pathname === '/api/proposal-done') { proposal()!.doneAt = now; return answer({}); }
    if (method === 'POST' && url.pathname === '/api/proposal-failed') { const p = proposal()!; p.failedAt = now; p.failure = body!.failure as string; return answer({}); }
    if (method === 'POST' && url.pathname === '/api/pickup-add') {
      if (this.pickups.some((u) => u.repo === body!.repo && u.issue === body!.number && u.doneAt === null)) return refuse('already picked up');
      this.pickups.push(pickupRow({ id: this.nextId++, repo: body!.repo as string, issue: body!.number as number, proposalId: (body!.proposalId as number | null) ?? null, askedAt: now }));
      return answer({});
    }
    if (method === 'POST' && url.pathname === '/api/pickup-claim') {
      const u = pickup();
      if (u.startedAt !== null) return refuse('taken');
      u.startedAt = now;
      return answer({ pickup: structuredClone(u) });
    }
    if (method === 'POST' && url.pathname === '/api/pickup-unclaim') { pickup().startedAt = null; return answer({}); }
    if (method === 'POST' && url.pathname === '/api/pickup-failed') { const u = pickup(); u.failedAt = now; u.failure = body!.failure as string; return answer({}); }
    if (method === 'POST' && url.pathname === '/api/pickup-done') { pickup().doneAt = now; return answer({}); }
    if (method === 'GET' && url.pathname === '/api/work') {
      const r = this.find(url.searchParams.get('repo')!, Number(url.searchParams.get('number')));
      if (!r) return reply(404, { error: 'not open on the board' });
      return reply(200, { record: r, answers: this.answers.filter((a) => a.workId === r.id) });
    }
    return reply(404, { error: 'Not found' });
  };
}

class World {
  /** The service's clock, in ms. */
  now = START;
  board = new Board(() => this.now);
  items = new Map<string, Item>();
  me = 'robot';
  /** From this many "which account" calls on, gh answers as the owner (the token was swapped). */
  ownerFromCall = Infinity;
  userCalls = 0;
  failWorktreeAdd = false;
  /** Sessions that ignore the polite stop signal. */
  ignoreTerm = false;
  /** When set, the next session fails to start, the way a missing program does. */
  spawnError: Error | null = null;
  files = new Map<string, string>([[TOKEN_PATH, 'tok-123\n'], [BOARD_TOKEN_PATH, JSON.stringify({ clientId: 'id', clientSecret: 'secret' })]]);
  dirs = new Set<string>([`${HOME}/code/x`, `${HOME}/code/y`]);
  executables = new Set<string>([CLAUDE]);
  marked = new Set<string>([`${HOME}/code/x`, `${HOME}/code/y`]);
  /** Worktrees by clone: branch → path. */
  worktrees = new Map<string, Map<string, string>>([[`${HOME}/code/x`, new Map([['main', `${HOME}/code/x`]])], [`${HOME}/code/y`, new Map([['main', `${HOME}/code/y`]])]]);
  localBranches = new Set<string>();
  /** Worktree paths git lists as prunable (their folder is gone). */
  prunable = new Set<string>();
  ghCalls: { line: string; token: string | undefined }[] = [];
  /** gh calls containing any of these fail, as GitHub refusing them. */
  ghRefuses: string[] = [];
  gitCalls: string[] = [];
  /** Every git call and board request, in order. */
  events: string[] = [];
  started: Started[] = [];
  /** Sessions started by an earlier run of the service, still in the process list. */
  earlier: { pid: number; name: string; startedAt: number }[] = [];
  signals: string[] = [];

  config(over: Record<string, unknown> = {}) {
    this.files.set(CONFIG_PATH, JSON.stringify({ repos: [{ repo: 'acme/x', clone: '~/code/x' }, { repo: 'acme/y', clone: '~/code/y' }], ...over }));
  }

  /** Adds a worktree on `branch`, with its folder. */
  worktree(clone: string, branch: string, path: string): void {
    this.worktrees.get(clone)!.set(branch, path);
    this.dirs.add(path);
  }

  /** A PR or issue on GitHub, and its record on the board, waiting on the owner with one question. */
  item(ref: string, kind: 'pr' | 'issue' = 'pr', branch = 'feature-a'): WorkRecord {
    const [repo, n] = ref.split('#');
    this.items.set(ref, { branch, headRepo: repo! });
    const record: WorkRecord = {
      id: this.board.records.length + 1, repo: repo!, issue: kind === 'issue' ? Number(n) : null, pr: kind === 'pr' ? Number(n) : null,
      hasDesign: true, gate: 'implementation', state: 'paused', reached: 'implementation', ask: 'look',
      questions: [{ n: 1, text: 'Colour?', choices: ['leave', 'change'], defaultChoice: 'leave' }], toTest: null, backReason: null,
      approved: { design: '2026-11-01T00:00:00Z' }, rounds: { design: 1, implementation: 0, prep: 0 }, prepSha: null, version: 3,
      turnSince: '2026-11-08T10:00:00Z', writtenAt: '2026-11-08T10:00:00Z', confirmedAt: null, startedAt: '2026-11-01T00:00:00Z', endedAt: null, endedHow: null,
    };
    this.board.records.push(record);
    return record;
  }

  /** An answer sent `ago` minutes before the service's clock, to the record's current version. */
  answer(ref: string, ago: number, choices: Record<string, string> = { '1': 'change' }, note = ''): number {
    const r = this.board.of(ref);
    const id = this.board.nextId++;
    this.board.answers.push({
      id, workId: r.id, version: r.version, at: new Date(this.now - ago * MIN).toISOString(), choices, approval: null, note,
      claimedAt: null, claimedBy: null, stateBefore: null, gaveUpAt: null, giveUpHint: null,
    });
    return id;
  }

  claims(): Sent[] {
    return this.board.posts('/api/claim');
  }

  ps(): string {
    const lines = ['  1 10-01:02:03 /sbin/launchd', `  77 05:00 ${CLAUDE} --resume abc`];
    for (const s of this.started) {
      if (s.alive) lines.push(`${s.pid} ${etime(this.now - s.startedAt)} ${s.cmd} ${s.args.join(' ')}`);
    }
    for (const e of this.earlier) lines.push(`${e.pid} ${etime(this.now - e.startedAt)} ${CLAUDE} --name ${e.name} -p Sam's answers\nwith more lines`);
    return `${lines.join('\n')}\n`;
  }

  gh: Gh = async (args, opts) => {
    const line = args.join(' ');
    this.ghCalls.push({ line, token: opts?.env?.GH_TOKEN });
    if (line === 'api user -q .login') {
      this.userCalls++;
      return `${this.userCalls >= this.ownerFromCall ? 'sam-gh' : this.me}\n`;
    }
    const head = /^api repos\/([^/]+\/[^/]+)\/pulls\/(\d+) -q .*head\.ref.*$/.exec(line);
    if (head) {
      const it = this.items.get(`${head[1]}#${head[2]}`)!;
      return `${it.headRepo}\t${it.branch}\n`;
    }
    if (/^api repos\/[^/]+\/[^/]+ -q \.default_branch$/.test(line)) return 'main\n';
    if (/^issue (edit|close) \d+ -R /.test(line)) {
      if (this.ghRefuses.some((r) => line.includes(r))) throw new Error(`gh ${line} failed: HTTP 403`);
      return '';
    }
    throw new Error(`unexpected gh call: ${line}`);
  };

  git: Gh = async (args) => {
    this.gitCalls.push(args.join(' '));
    this.events.push(`git ${args.slice(2).join(' ')}`);
    const [flag, clone, ...rest] = args;
    if (flag !== '-C' || !clone) throw new Error(`unexpected git call: ${args.join(' ')}`);
    const cmd = rest.join(' ');
    if (cmd === 'config --local --get claude.bot') {
      if (this.marked.has(clone)) return 'true\n';
      throw new Error('git config failed: ');
    }
    if (cmd === 'worktree list --porcelain') {
      return [...(this.worktrees.get(clone) ?? [])]
        .map(([b, p]) => `worktree ${p}\nHEAD 0123abcd\nbranch refs/heads/${b}\n${this.prunable.has(p) ? 'prunable gitdir file points to non-existent location\n' : ''}`).join('\n');
    }
    if (rest[0] === 'fetch') return '';
    if (rest[0] === 'checkout' && rest[1] === '--detach') return '';
    if (rest[0] === 'rev-parse') {
      if (this.localBranches.has(rest[rest.length - 1]!.replace('refs/heads/', ''))) return 'abc\n';
      throw new Error('git rev-parse failed: ');
    }
    if (rest[0] === 'worktree' && rest[1] === 'add') {
      if (this.failWorktreeAdd) throw new Error('git worktree add failed: disk full');
      const b = rest.includes('-b') ? rest[rest.indexOf('-b') + 1]! : rest[rest.length - 1]!;
      const path = rest.find((a) => a.startsWith('/'))!;
      this.worktrees.get(clone)!.set(b, path);
      this.dirs.add(path);
      return '';
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

/** Runs the service until it stops itself, `onSleep` calls `stop`, or 20 waits have passed. */
async function run(world: World, argv: string[], onSleep: (count: number, ms: number, stop: () => void) => void = () => {}, over: Partial<ServiceDeps> = {}) {
  const sleeps: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stop = new AbortController();
  const readFile = (p: string) => {
    const text = world.files.get(p);
    if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
    return text;
  };
  const boardFetch: typeof fetch = async (input, init) => {
    world.events.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return world.board.fetch(input, init);
  };
  const deps: ServiceDeps = {
    gh: world.gh,
    git: world.git,
    board: { fetch: boardFetch, readFile, env: {}, home: HOME },
    ps: async (args) => {
      if (args.join(' ') !== '-axww -o pid=,etime=,args=') throw new Error(`unexpected ps call: ${args.join(' ')}`);
      return world.ps();
    },
    files: {
      read: readFile,
      isDirectory: (p) => world.dirs.has(p),
      isExecutable: (p) => world.executables.has(p),
      mkdir: (p) => { world.dirs.add(p); },
    },
    kill: (pid, signal) => {
      world.signals.push(`${signal} ${pid}`);
      if (signal === 'SIGTERM' && world.ignoreTerm) return;
      world.started.find((s) => s.pid === -pid)?.finish(143);
    },
    homedir: HOME,
    env: { PATH: '/usr/bin' },
    now: () => world.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      world.now += ms;
      if (sleeps.length > 200) throw new Error('the service never stopped');
      onSleep(sleeps.length, ms, () => stop.abort());
      if (sleeps.length >= 20) stop.abort();
    },
    spawn: (cmd, args, opts) => {
      const pid = 4001 + world.started.length;
      let end: (code: number) => void = () => {};
      const exited = new Promise<number | null>((resolve) => { end = resolve; });
      const s: Started = { pid, cmd, args, opts, startedAt: world.now, alive: true, finish: (code) => { s.alive = false; end(code); } };
      world.started.push(s);
      const spawned = world.spawnError ? Promise.reject(world.spawnError) : Promise.resolve();
      spawned.catch(() => {});
      if (world.spawnError) s.alive = false;
      return { pid, spawned, exited };
    },
    signal: stop.signal,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  const code = await main(argv, deps);
  return { code, sleeps, out: out.join('\n'), err: err.join('\n'), stop };
}

describe('loadConfig', () => {
  it('fills in the defaults and expands ~ to the home directory', () => {
    const c = loadConfig(JSON.stringify({ repos: [{ repo: 'acme/x', clone: '~/code/x' }] }), HOME, CONFIG_PATH);
    expect(c).toEqual({
      repos: [{ owner: 'acme', repo: 'x', clone: `${HOME}/code/x` }],
      graceMs: 5 * MIN, maxSessions: 4, sessionMs: 60 * MIN, pollMs: POLL,
      logDir: `${HOME}/.pr-board/logs`, tokenFile: TOKEN_PATH, claudeTokenFile: null, claude: CLAUDE, claudeArgs: [],
    });
  });

  it('reads the example file in mac/, which spells every default', () => {
    const text = readFileSync(new URL('../mac/service.example.json', import.meta.url), 'utf8');
    const { repos, ...rest } = loadConfig(text, HOME, 'service.example.json');
    const { repos: _, ...defaults } = loadConfig(JSON.stringify({ repos: [{ repo: 'a/b', clone: '/c' }] }), HOME, 'x');
    expect(repos.length).toBeGreaterThan(0);
    expect(rest).toEqual(defaults);
  });

  it('takes every setting from the file', () => {
    const c = loadConfig(JSON.stringify({
      repos: [{ repo: 'acme/x', clone: '/src/x' }], graceMinutes: 3, maxSessions: 1, sessionMinutes: 20, pollSeconds: 30,
      logDir: '/var/log/b', tokenFile: '/etc/t', claudeTokenFile: '~/c', claude: '/opt/claude', claudeArgs: ['--permission-mode', 'acceptEdits'],
    }), HOME, CONFIG_PATH);
    expect(c).toMatchObject({ graceMs: 3 * MIN, maxSessions: 1, sessionMs: 20 * MIN, pollMs: 30_000, logDir: '/var/log/b', tokenFile: '/etc/t', claudeTokenFile: `${HOME}/c`, claude: '/opt/claude', claudeArgs: ['--permission-mode', 'acceptEdits'] });
  });

  it.each([
    ['not json', 'is not valid JSON'],
    ['[]', 'must hold one JSON object'],
    ['{}', '"repos" must be a list'],
    ['{"repos": []}', '"repos" must be a list'],
    ['{"repos": [{"repo": "x", "clone": "/a"}]}', '"repo" must look like owner/name'],
    ['{"repos": [{"repo": "a/x", "clone": "rel/path"}]}', 'must be an absolute path'],
    ['{"repos": [{"repo": "a/x", "clone": "/a"}, {"repo": "a/x", "clone": "/b"}]}', 'a/x appears twice'],
    ['{"repos": [{"repo": "a/x", "clone": "/a"}], "graceMinutes": -1}', '"graceMinutes" must be a number'],
    ['{"repos": [{"repo": "a/x", "clone": "/a"}], "maxSessions": 0}', '"maxSessions" must be a whole number'],
    ['{"repos": [{"repo": "a/x", "clone": "/a"}], "sessionMinutes": 0}', '"sessionMinutes" must be a number'],
    ['{"repos": [{"repo": "a/x", "clone": "/a"}], "claudeArgs": "--x"}', '"claudeArgs" must be a list of strings'],
    ['{"repos": [{"repo": "a/x", "clone": "/a"}], "stateDir": "/s"}', 'unknown setting "stateDir"'],
  ])('refuses %s, saying why', (text, why) => {
    expect(() => loadConfig(text, HOME, CONFIG_PATH)).toThrow(why);
    expect(() => loadConfig(text, HOME, CONFIG_PATH)).toThrow(CONFIG_PATH);
  });
});

describe('runningSessions', () => {
  it('finds the service’s sessions by their name, with how long each has run, and nothing else', () => {
    const ps = [
      '    1 10-01:02:03 /sbin/launchd',
      `  101 05:07 ${CLAUDE} --name acme/x#5 answers -p Sam's answers`,
      'to acme/x#5, on a line of its own in the prompt',
      ` 2202 01:00:00 ${CLAUDE} --name acme/y#7 answers -p x --permission-mode auto`,
      ` 3303 2-03:04:05 ${CLAUDE} --name acme/z#9 answers -p y`,
      `  404 00:10 ${CLAUDE} --resume abc`,
      `  505 00:10 /opt/other --name acme/x#6 answers -p z`,
      `  606 00:10 ${CLAUDE} --name my notes -p z`,
    ].join('\n');
    expect([...runningSessions(ps, CLAUDE)]).toEqual([
      ['acme/x#5', { pid: 101, elapsedMs: (5 * 60 + 7) * 1000 }],
      ['acme/y#7', { pid: 2202, elapsedMs: 3600 * 1000 }],
      ['acme/z#9', { pid: 3303, elapsedMs: ((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000 }],
    ]);
  });
});

describe('mac-service', () => {
  it('claims on the board an answer nobody claimed in 5 minutes and starts a fresh session for it in the PR’s worktree', async () => {
    const w = new World();
    w.config({ claudeArgs: ['--permission-mode', 'acceptEdits'] });
    w.item('acme/x#5');
    w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
    const id = w.answer('acme/x#5', 6, { '1': 'change' }, 'and the border');
    const r = await run(w, ['--once']);
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([]);
    expect(w.board.posts('/api/unclaimed')[0]!.body).toEqual({ olderThanMs: 5 * MIN });
    expect(w.claims().map((s) => s.body)).toEqual([{ repo: 'acme/x', number: 5, by: 'service' }]);
    expect(w.board.answer(id)).toMatchObject({ claimedBy: 'service' });
    // The claim itself says a Mac session is working on it.
    expect(w.board.of('acme/x#5')).toMatchObject({ state: 'working', ask: SERVICE_WORKING_ASK });
    expect(w.started).toHaveLength(1);
    const s = w.started[0]!;
    expect(s.cmd).toBe(CLAUDE);
    expect(s.args.slice(0, 3)).toEqual(['--name', 'acme/x#5 answers', '-p']);
    expect(s.args.slice(4)).toEqual(['--permission-mode', 'acceptEdits']);
    expect(s.opts.cwd).toBe(`${HOME}/code/x/.claude/worktrees/feature-a`);
    expect(s.opts.env.GH_TOKEN).toBe('tok-123');
    expect(s.opts.env.PATH).toBe('/usr/bin');
    expect(s.opts.logPath).toMatch(new RegExp(`^${HOME}/\\.pr-board/logs/acme-x-5-.*\\.log$`));
    const prompt = s.args[3]!;
    expect(prompt).toContain("Sam's answers from PR Board to acme/x#5");
    expect(prompt).toContain(`in ${HOME}/code/x/.claude/worktrees/feature-a`);
    expect(prompt).toContain(SERVICE_WORKING_ASK);
    expect(prompt).toContain(describeAnswers(w.board.of('acme/x#5'), [w.board.answer(id)]));
    expect(prompt).toContain('1. Colour? → change');
    expect(prompt).toContain('Note: and the border');
    expect(prompt).toContain('Follow the pr-status skill under "Answers from the board"');
    expect(prompt).toContain('--state paused, complete or parked, never working');
    expect(prompt).not.toContain('👀');
    expect(r.out).toContain('acme/x#5: started a session (process 4001)');
    // GitHub is only read: the branch, never a reaction or a status.
    expect(w.ghCalls.some((c) => c.line.includes(' -X '))).toBe(false);
    expect(w.ghCalls.every((c) => c.token === 'tok-123')).toBe(true);
    expect(w.dirs.has(`${HOME}/.pr-board/logs`)).toBe(true);
  });

  it('claims only after the worktree and the prompt are ready', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    await run(w, ['--once']);
    const add = w.events.findIndex((e) => e.startsWith('git worktree add'));
    const claim = w.events.indexOf('POST /api/claim');
    expect(add).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(add);
    expect(w.started).toHaveLength(1);
  });

  it('leaves an answer alone during its grace period and takes it once that has passed', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 1);
    let claimsBefore = -1;
    // The board hands over answers older than the grace period: sent a minute before the first look, this one is taken at the sixth.
    const r = await run(w, [], (n, _, stop) => { if (n === 4) claimsBefore = w.claims().length; if (n === 6) stop(); });
    expect(r.code).toBe(0);
    expect(claimsBefore).toBe(0);
    expect(w.started).toHaveLength(1);
    expect(w.claims()).toHaveLength(1);
  });

  it('creates a worktree from the PR’s branch when it has none, fetching first', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5', 'pr', 'fix/thing');
    w.answer('acme/x#5', 6);
    await run(w, ['--once']);
    const path = `${HOME}/code/x/.claude/worktrees/fix/thing`;
    expect(w.gitCalls).toContain(`-C ${HOME}/code/x fetch -- origin fix/thing`);
    expect(w.gitCalls).toContain(`-C ${HOME}/code/x worktree add --track -b fix/thing -- ${path} origin/fix/thing`);
    expect(w.started[0]!.opts.cwd).toBe(path);
  });

  it('uses the local branch when there is one but no worktree has it', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.localBranches.add('feature-a');
    w.answer('acme/x#5', 6);
    await run(w, ['--once']);
    expect(w.gitCalls).toContain(`-C ${HOME}/code/x worktree add -- ${HOME}/code/x/.claude/worktrees/feature-a feature-a`);
  });

  it('creates an issue-N worktree on a new branch from the default branch for an issue', async () => {
    const w = new World();
    w.config();
    w.item('acme/y#7', 'issue');
    w.answer('acme/y#7', 6);
    await run(w, ['--once']);
    const path = `${HOME}/code/y/.claude/worktrees/issue-7`;
    expect(w.gitCalls).toContain(`-C ${HOME}/code/y fetch -- origin main`);
    expect(w.gitCalls).toContain(`-C ${HOME}/code/y worktree add --no-track -b issue-7 -- ${path} origin/main`);
    expect(w.started[0]!.opts.cwd).toBe(path);
    expect(w.started[0]!.args[3]).toContain(`in ${path}`);
    expect(w.claims().map((s) => s.body)).toEqual([{ repo: 'acme/y', number: 7, by: 'service' }]);
    expect(w.board.of('acme/y#7')).toMatchObject({ state: 'working', ask: SERVICE_WORKING_ASK });
  });

  it('reuses an issue-N worktree that already exists', async () => {
    const w = new World();
    w.config();
    w.item('acme/y#7', 'issue');
    w.worktree(`${HOME}/code/y`, 'issue-7', '/elsewhere/issue-7');
    w.answer('acme/y#7', 6);
    await run(w, ['--once']);
    expect(w.gitCalls.some((c) => c.includes('worktree add'))).toBe(false);
    expect(w.started[0]!.opts.cwd).toBe('/elsewhere/issue-7');
  });

  describe('which worktree it will work in', () => {
    const X = `${HOME}/code/x`;
    const refused = async (w: World, why: string) => {
      const r = await run(w, ['--once']);
      expect(w.started).toHaveLength(0);
      expect(w.claims()).toHaveLength(0);
      expect(w.gitCalls.some((c) => c.includes('worktree add'))).toBe(false);
      expect(r.err).toContain(why);
    };

    it('never works in the main checkout, even when the PR’s branch is the one checked out there', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5', 'pr', 'main');
      w.answer('acme/x#5', 6);
      await refused(w, 'checked out in the main checkout');
    });

    it('does not reuse a worktree git lists as prunable, and makes a new one instead', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.worktree(X, 'feature-a', `${X}/.claude/worktrees/feature-a`);
      w.prunable.add(`${X}/.claude/worktrees/feature-a`);
      w.dirs.delete(`${X}/.claude/worktrees/feature-a`);
      w.answer('acme/x#5', 6);
      await run(w, ['--once']);
      expect(w.gitCalls.some((c) => c.includes('worktree add'))).toBe(true);
      expect(w.started[0]!.opts.cwd).toBe(`${X}/.claude/worktrees/feature-a`);
    });

    it('refuses a worktree whose path is not a directory', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.worktree(X, 'feature-a', '/gone/feature-a');
      w.dirs.delete('/gone/feature-a');
      w.answer('acme/x#5', 6);
      await refused(w, "worktree /gone/feature-a for feature-a isn't a directory");
    });

    it('refuses a PR whose branch comes from a fork', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.items.get('acme/x#5')!.headRepo = 'stranger/x';
      w.answer('acme/x#5', 6);
      await refused(w, 'stranger/x');
    });

    it('refuses a branch name that git would read as an option', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5', 'pr', '--upload-pack=evil');
      w.answer('acme/x#5', 6);
      await refused(w, 'starts with "-"');
    });
  });

  it('refuses to start a session in a repo not marked claude.bot, and leaves the answer unclaimed', async () => {
    const w = new World();
    w.config();
    w.marked.delete(`${HOME}/code/x`);
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const r = await run(w, ['--once']);
    expect(w.started).toHaveLength(0);
    expect(w.claims()).toHaveLength(0);
    expect(r.err).toContain(`${HOME}/code/x is not marked claude.bot=true`);
  });

  it('leaves alone, saying so once, answers on the board for a repo it does not serve', async () => {
    const w = new World();
    w.config();
    w.item('other/z#3');
    w.answer('other/z#3', 6);
    const r = await run(w, [], (n, _, stop) => { if (n === 3) stop(); });
    expect(w.claims()).toHaveLength(0);
    expect(w.started).toHaveLength(0);
    expect(r.out.match(/other\/z#3: has answers nobody picked up, but other\/z is not one of the repos this service serves/g)).toHaveLength(1);
  });

  it.each([['missing', undefined], ['empty', '  \n']])('does not start a session when the token file is %s, and leaves the answer unclaimed', async (_, text) => {
    const w = new World();
    w.config();
    if (text === undefined) w.files.delete(TOKEN_PATH);
    else w.files.set(TOKEN_PATH, text);
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const r = await run(w, ['--once']);
    expect(w.started).toHaveLength(0);
    expect(w.claims()).toHaveLength(0);
    expect(r.err).toContain(`${TOKEN_PATH} is missing or empty`);
  });

  it('gives the session the Claude sign-in token from claudeTokenFile, and none without the setting', async () => {
    const w = new World();
    w.config({ claudeTokenFile: '~/.config/claude-code/oauth-token' });
    w.files.set(`${HOME}/.config/claude-code/oauth-token`, 'oat-456\n');
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    await run(w, ['--once']);
    expect(w.started[0]!.opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-456');

    const plain = new World();
    plain.config();
    plain.item('acme/x#5');
    plain.answer('acme/x#5', 6);
    await run(plain, ['--once']);
    expect(plain.started[0]!.opts.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it.each([['missing', undefined], ['empty', '  \n']])('does not start a session when claudeTokenFile is set but %s, and leaves the answer unclaimed', async (_, text) => {
    const w = new World();
    w.config({ claudeTokenFile: '/c/oauth-token' });
    if (text !== undefined) w.files.set('/c/oauth-token', text);
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const r = await run(w, ['--once']);
    expect(w.started).toHaveLength(0);
    expect(w.claims()).toHaveLength(0);
    expect(r.err).toContain('/c/oauth-token is missing or empty, so the session couldn\'t sign in to Claude');
  });

  describe('a claimed answer is never silently lost', () => {
    it('claims nothing when something fails before the claim, such as making the worktree', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.failWorktreeAdd = true;
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.claims()).toHaveLength(0);
      expect(w.board.answer(id).claimedAt).toBeNull();
      expect(w.started).toHaveLength(0);
      expect(r.err).toContain('disk full');
    });

    it('gives the claim back on the board when the session fails to start, and says so', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
      w.spawnError = new Error('spawn claude ENOENT');
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.claims()).toHaveLength(1);
      expect(w.board.posts('/api/unclaim').map((s) => s.body)).toEqual([{ answerIds: [id] }]);
      expect(w.board.answer(id).claimedAt).toBeNull();
      expect(w.board.of('acme/x#5')).toMatchObject({ state: 'paused', ask: 'look' });
      expect(r.err).toContain('acme/x#5: ');
      expect(r.err).toContain('spawn claude ENOENT');
      expect(r.err).toContain('gave its answers back on the board');
      expect(r.out).not.toContain('started a session');
    });

    it('hands the item back at the next look when the claim could not be given back either', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.spawnError = new Error('spawn claude ENOENT');
      w.board.fail.set('/api/unclaim', 1);
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => { if (n === 2) stop(); });
      expect(r.err).toContain("couldn't give its answers back on the board");
      expect(w.board.posts('/api/gave-up').map((s) => s.body?.answerIds)).toEqual([[id]]);
      expect(w.board.of('acme/x#5')).toMatchObject({ state: 'paused', ask: GAVE_UP_ASK });
    });

    it('refuses to claim when the GitHub token turns out to be the owner’s at the moment of the claim', async () => {
      const w = new World();
      w.config();
      w.ownerFromCall = 2;
      w.item('acme/x#5');
      w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
      w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.claims()).toHaveLength(0);
      expect(w.started).toHaveLength(0);
      expect(r.err).toContain("signed in as sam-gh, the board's owner");
    });

    it('leaves answers to the session that claimed them first, and never hands them back', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      const id = w.answer('acme/x#5', 6);
      w.board.lostRace.add(id);
      const r = await run(w, [], (n, _, stop) => { if (n === 3) stop(); });
      expect(w.started).toHaveLength(0);
      expect(w.board.answer(id)).toMatchObject({ claimedBy: 'session', gaveUpAt: null });
      expect(r.out).toContain('acme/x#5: another session claimed its answers first; leaving them to that one.');
      expect(w.board.posts('/api/unclaim')).toHaveLength(0);
      expect(w.board.posts('/api/gave-up')).toHaveLength(0);
    });

    it('hands the item back when the board took the claim but its reply was lost, so no session started', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      const id = w.answer('acme/x#5', 6);
      w.board.lostReply.add('/api/claim');
      const r = await run(w, [], (n, _, stop) => { if (n === 2) stop(); });
      expect(w.started).toHaveLength(0);
      expect(r.err).toMatch(/acme\/x#5: .*⚠️ The board answered 502/);
      expect(w.board.posts('/api/gave-up').map((s) => s.body?.answerIds)).toEqual([[id]]);
      expect(w.board.of('acme/x#5')).toMatchObject({ state: 'paused', ask: GAVE_UP_ASK });
    });

    it('one item whose claim fails does not stop the items after it, nor slow the service down', async () => {
      const w = new World();
      w.config({ maxSessions: 3 });
      for (const n of [5, 6, 8]) { w.item(`acme/x#${n}`, 'pr', `b-${n}`); w.answer(`acme/x#${n}`, 6); }
      w.board.fail.set('/api/claim', 1);
      const r = await run(w, [], (n, _, stop) => { if (n === 1) stop(); });
      expect(w.started.map((s) => s.args[1])).toEqual(['acme/x#6 answers', 'acme/x#8 answers']);
      expect(r.err).toMatch(/acme\/x#5: .*⚠️ The board answered 502/);
      expect(r.sleeps[0]).toBe(POLL);
    });
  });

  it('starts no more sessions at once than allowed, and starts the next once one finishes', async () => {
    const w = new World();
    w.config({ maxSessions: 2 });
    for (const n of [5, 6, 8]) { w.item(`acme/x#${n}`); w.answer(`acme/x#${n}`, 6); }
    const counts: number[] = [];
    const r = await run(w, [], (n, _, stop) => {
      counts.push(w.started.length);
      if (n === 2) w.started[0]!.finish(0);
      if (n === 4) stop();
    });
    expect(counts.slice(0, 3)).toEqual([2, 2, 3]);
    expect(w.claims()).toHaveLength(3);
    expect(r.out.match(/acme\/x#8: has answers nobody picked up, but 2 sessions are already running/g)).toHaveLength(1);
  });

  it('puts every waiting answer on an item into one session', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    const a = w.answer('acme/x#5', 8, { '1': 'change' });
    const b = w.answer('acme/x#5', 7, {}, 'one more thing');
    await run(w, ['--once']);
    expect(w.started).toHaveLength(1);
    expect(w.started[0]!.args[3]).toContain('1. Colour? → change');
    expect(w.started[0]!.args[3]).toContain('Note: one more thing');
    expect(w.board.answer(a).claimedBy).toBe('service');
    expect(w.board.answer(b).claimedBy).toBe('service');
  });

  it('with --dry-run, claims nothing, creates no worktree, starts nothing and writes nothing to the board, but says what it would do', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.item('acme/y#7', 'issue');
    w.answer('acme/x#5', 6);
    w.answer('acme/y#7', 6);
    // A claim of the service's with no session running, which a real run would hand back.
    w.item('acme/x#9');
    w.answer('acme/x#9', 30);
    w.board.claim(w.board.of('acme/x#9'), 'service');
    const r = await run(w, ['--dry-run', '--once']);
    expect(r.code).toBe(0);
    // Asking for the unclaimed answers is a POST that only reads; nothing else is posted.
    expect(w.board.posts().filter((s) => s.path !== '/api/unclaimed')).toEqual([]);
    expect(w.board.of('acme/x#5')).toMatchObject({ state: 'paused', ask: 'look' });
    expect(w.board.of('acme/x#9')).toMatchObject({ state: 'working', ask: SERVICE_WORKING_ASK });
    expect(w.ghCalls.some((c) => c.line.includes(' -X '))).toBe(false);
    expect(w.started).toHaveLength(0);
    expect(w.gitCalls.some((c) => / (fetch|worktree add) /.test(c))).toBe(false);
    expect(w.dirs.has(`${HOME}/.pr-board/logs`)).toBe(false);
    expect(r.out).toContain(`acme/x#5: would create the worktree ${HOME}/code/x/.claude/worktrees/feature-a`);
    expect(r.out).toContain(`acme/x#5: would claim and start: ${CLAUDE} --name "acme/x#5 answers" -p`);
    expect(r.out).toContain('1. Colour? → change');
    expect(r.out).toContain('acme/x#9: its session is no longer running and no new status was written; would hand the item back to Sam');
  });

  it('says when there is nothing to do', async () => {
    const w = new World();
    w.config();
    const r = await run(w, ['--once']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('No answers waiting past the 5 min grace period; nothing to do.');
  });

  it('keeps going through board errors, putting the ⚠️ first, waiting longer each time up to 5 minutes, and back to the usual wait after', async () => {
    const w = new World();
    w.config();
    w.board.fail.set('/api/unclaimed', 5);
    w.item('acme/y#7', 'issue');
    w.answer('acme/y#7', 6);
    const r = await run(w, [], (n, _, stop) => { if (n === 7) stop(); });
    expect(w.started).toHaveLength(1);
    expect(r.sleeps.slice(0, 7)).toEqual([120_000, 240_000, 300_000, 300_000, 300_000, POLL, POLL]);
    expect(r.err.split('\n')).toContain('⚠️ The board answered 502 to https://board.example.test/api/unclaimed: Bad Gateway. Nothing was written; try again.');
    expect(r.code).toBe(0);
  });

  it('says ⚠️ and names the board token file when it is missing, and keeps going', async () => {
    const w = new World();
    w.config();
    w.files.delete(BOARD_TOKEN_PATH);
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const r = await run(w, [], (n, _, stop) => { if (n === 2) stop(); });
    expect(r.code).toBe(0);
    expect(w.started).toHaveLength(0);
    expect(r.err).toContain(`⚠️ Couldn't read the board's service token at ${BOARD_TOKEN_PATH}`);
    expect(r.sleeps.slice(0, 2)).toEqual([120_000, 240_000]);
  });

  it('starts nothing, and backs off, when it can’t read the process list', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const r = await run(w, ['--once'], undefined, { ps: async () => { throw new Error('ps: not found'); } });
    expect(r.code).toBe(1);
    expect(w.started).toHaveLength(0);
    expect(w.claims()).toHaveLength(0);
    expect(r.err).toContain("Couldn't list the running processes (ps: not found)");
  });

  it('stops cleanly when asked, leaving its sessions running', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const stop = new AbortController();
    const r = await run(w, [], (n) => { if (n === 1) stop.abort(); }, { signal: stop.signal });
    expect(r.code).toBe(0);
    expect(r.sleeps).toHaveLength(1);
    expect(r.out).toContain('Stopping; its sessions carry on (1 running at the last look)');
  });

  it("refuses to start under the owner's own GitHub account", async () => {
    const w = new World();
    w.config();
    w.me = 'sam-gh';
    const r = await run(w, ['--once']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("signed in as sam-gh, the board's owner");
  });

  it('stops at startup on a missing or bad config, or a claude it cannot run', async () => {
    const w = new World();
    let r = await run(w, ['--once']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Couldn't read ${CONFIG_PATH}`);

    w.config();
    w.executables.clear();
    r = await run(w, ['--once']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${CLAUDE} isn't a program it can run`);
  });

  it('skips, saying so once, a repo whose clone is missing or not marked claude.bot, and serves the rest', async () => {
    const w = new World();
    w.config();
    w.dirs.delete(`${HOME}/code/x`);
    w.marked.delete(`${HOME}/code/y`);
    let r = await run(w, ['--once']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Skipping acme/x: ${HOME}/code/x, the clone of acme/x, isn't a directory`);
    expect(r.err).toContain(`Skipping acme/y: ${HOME}/code/y is not marked claude.bot=true`);
    expect(r.err).toContain('No repo is left to serve');

    w.marked.add(`${HOME}/code/y`);
    w.item('acme/y#7', 'issue');
    w.answer('acme/y#7', 6);
    r = await run(w, [], (n, _, stop) => { if (n === 3) stop(); });
    expect(r.code).toBe(0);
    expect(r.err.match(/Skipping acme\/x/g)).toHaveLength(1);
    expect(w.started).toHaveLength(1);
  });

  describe('when a session ends', () => {
    const X = `${HOME}/code/x`;
    const setup = (over: Record<string, unknown> = {}) => {
      const w = new World();
      w.config(over);
      w.item('acme/x#5');
      w.worktree(X, 'feature-a', `${X}/.claude/worktrees/feature-a`);
      return w;
    };

    it('does nothing when the session wrote a new status', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) { w.board.newStatus('acme/x#5'); w.started[0]!.finish(0); }
        if (n === 4) stop();
      });
      expect(w.board.posts('/api/gave-up')).toHaveLength(0);
      expect(w.board.answer(id).gaveUpAt).toBeNull();
      expect(w.board.of('acme/x#5')).toMatchObject({ state: 'complete', ask: 'next look' });
      expect(r.out).toContain('acme/x#5: the session ended after a new status was written, or the item closed; nothing to do.');
      expect(w.started).toHaveLength(1);
    });

    it('gives up on the board, with where its output is, when the session ended with the version unchanged, and never takes those answers again', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) w.started[0]!.finish(1);
        if (n === 6) stop();
      });
      const gaveUp = w.board.posts('/api/gave-up');
      expect(gaveUp).toHaveLength(1);
      expect(gaveUp[0]!.body!.answerIds).toEqual([id]);
      expect(gaveUp[0]!.body!.hint).toContain(`acme-x-5-*.log in ${HOME}/.pr-board/logs`);
      expect(w.board.of('acme/x#5')).toMatchObject({ state: 'paused', ask: GAVE_UP_ASK });
      expect(w.board.answers.find((a) => a.id === id)!.giveUpHint).toContain('acme-x-5-*.log');
      expect(r.err).toContain('acme/x#5: the session ended without writing a new status. Handed the item back to Sam');
      expect(w.started).toHaveLength(1);

      // Even after a restart it stays away from those answers; a new answer is another matter.
      await run(w, ['--once']);
      expect(w.started).toHaveLength(1);
      w.answer('acme/x#5', 0);
      w.now += 6 * MIN;
      await run(w, ['--once']);
      expect(w.started).toHaveLength(2);
    });

    it('checks a session that ended before the next look', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      const spawn = (cmd: string, args: string[], opts: SpawnOptions) => {
        const pid = 4001;
        const s: Started = { pid, cmd, args, opts, startedAt: w.now, alive: false, finish: () => {} };
        w.started.push(s);
        return { pid, spawned: Promise.resolve(), exited: Promise.resolve(1) };
      };
      await run(w, [], (n, _, stop) => { if (n === 2) stop(); }, { spawn });
      expect(w.board.answer(id).gaveUpAt).not.toBeNull();
    });

    it('tries giving up again at the next look when the board fails', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      w.board.fail.set('/api/gave-up', 1);
      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) w.started[0]!.finish(1);
        if (n === 3) stop();
      });
      expect(r.err).toMatch(/acme\/x#5: .*⚠️ The board answered 502/);
      expect(w.board.posts('/api/gave-up')).toHaveLength(2);
      expect(w.board.answer(id).gaveUpAt).not.toBeNull();
      expect(w.board.of('acme/x#5')).toMatchObject({ ask: GAVE_UP_ASK });
    });

    it('does nothing when the item closed while its session ran', async () => {
      const w = setup();
      w.answer('acme/x#5', 6);
      await run(w, [], (n, _, stop) => {
        if (n === 1) { w.board.of('acme/x#5').endedAt = new Date(w.now).toISOString(); w.started[0]!.finish(0); }
        if (n === 3) stop();
      });
      expect(w.board.posts('/api/gave-up')).toHaveLength(0);
    });

    it('stops the whole process group of a session that runs past the time limit, then gives up', async () => {
      const w = setup({ sessionMinutes: 5 });
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => { if (n === 8) stop(); });
      expect(w.signals).toEqual(['SIGTERM -4001']);
      expect(r.err).toContain('acme/x#5: its session (process 4001) has run for 5 min, past the 5 min limit; stopping it.');
      expect(w.board.answer(id).gaveUpAt).not.toBeNull();
      expect(w.board.of('acme/x#5')).toMatchObject({ ask: GAVE_UP_ASK });
    });

    it('forces a session to stop when it is still there a minute after being asked', async () => {
      const w = setup({ sessionMinutes: 5 });
      w.ignoreTerm = true;
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => { if (n === 9) stop(); });
      expect(w.signals).toEqual(['SIGTERM -4001', 'SIGKILL -4001']);
      expect(r.err).toContain('acme/x#5: its session (process 4001) is still running a minute after being asked to stop; forcing it to stop.');
      expect(w.board.answer(id).gaveUpAt).not.toBeNull();
    });

    it('after a restart counts the sessions still running, and gives up the claims whose sessions ended while it was down', async () => {
      const w = new World();
      w.config({ maxSessions: 1 });
      // A session from before, still running.
      w.item('acme/x#5');
      w.answer('acme/x#5', 12);
      w.board.claim(w.board.of('acme/x#5'), 'service');
      w.earlier.push({ pid: 7001, name: 'acme/x#5 answers', startedAt: w.now - 10 * MIN });
      // One that ended while the service was down, on an issue, without writing a new status.
      w.item('acme/y#7', 'issue');
      const dead = w.answer('acme/y#7', 20);
      w.board.claim(w.board.of('acme/y#7'), 'service');
      // One the service handled long ago, whose session wrote a new status, and one a watcher claimed: both left alone.
      w.item('acme/x#9');
      const handled = w.answer('acme/x#9', 300);
      w.board.claim(w.board.of('acme/x#9'), 'service');
      w.board.newStatus('acme/x#9');
      w.item('acme/x#10', 'issue');
      const watched = w.answer('acme/x#10', 30);
      w.board.claim(w.board.of('acme/x#10'), 'session');
      // Waiting for a place.
      w.item('acme/x#6');
      w.answer('acme/x#6', 20);

      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) w.earlier = [];
        if (n === 3) stop();
      });
      expect(r.out).toContain('Found 1 session of its own still running: acme/x#5.');
      expect(r.out).toContain('At startup, 2 items had answers claimed by its sessions; 1 had no session still running and went back to Sam: acme/y#7.');
      expect(w.board.answer(dead).gaveUpAt).not.toBeNull();
      expect(w.board.of('acme/y#7')).toMatchObject({ state: 'paused', ask: GAVE_UP_ASK });
      expect(w.board.answer(handled).gaveUpAt).toBeNull();
      expect(w.board.answer(watched).gaveUpAt).toBeNull();
      expect(w.board.of('acme/x#10')).toMatchObject({ ask: WORKING_ASK });
      // The one still running filled the one place until it was gone; then the waiting item started.
      expect(r.out).toContain('acme/x#6: has answers nobody picked up, but 1 session is already running');
      expect(w.started.map((s) => s.args[1])).toEqual(['acme/x#6 answers']);
      // The earlier session ended without writing a new status, so that went back to the owner too.
      expect(w.board.of('acme/x#5')).toMatchObject({ state: 'paused', ask: GAVE_UP_ASK });
      expect(r.out).not.toContain('acme/x#9:');
    });
  });

  it('reads the config from --config, else from PR_BOARD_SERVICE_CONFIG', async () => {
    const w = new World();
    w.files.set('/etc/a.json', JSON.stringify({ repos: [{ repo: 'acme/x', clone: '~/code/x' }] }));
    w.files.set('/etc/b.json', 'nope');
    expect((await run(w, ['--once', '--config', '/etc/a.json'], undefined, { env: { PR_BOARD_SERVICE_CONFIG: '/etc/b.json' } })).code).toBe(0);
    const r = await run(w, ['--once'], undefined, { env: { PR_BOARD_SERVICE_CONFIG: '/etc/b.json' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('/etc/b.json: is not valid JSON');
  });

  it('refuses arguments it does not know', async () => {
    const w = new World();
    w.config();
    const r = await run(w, ['--bogus']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Usage: mac-service');
  });
});

describe('mac-service and the backlog', () => {
  const BACKLOG_DIR = `${HOME}/code/x/.claude/worktrees/backlog`;
  const written = (over: Partial<Proposal> = {}) => proposalRow({
    id: 1, repo: 'acme/x', startedAt: '2026-11-08T10:05:00.000Z', writtenAt: '2026-11-08T10:10:00.000Z',
    items: [
      { issue: 25, title: 'Stop hook', suggestion: 'pick up', reason: 'small' },
      { issue: 11, title: 'Fewer requests', suggestion: 'close', reason: 'done by #20' },
      { issue: 3, title: 'Timeline', suggestion: 'later', reason: 'large' },
    ],
    answeredAt: '2026-11-08T10:20:00.000Z', answers: { 25: 'pick up', 11: 'close', 3: 'later' }, note: '', ...over,
  });

  it('tells the board at each look how many sessions run, its limit and the repos it serves', async () => {
    const w = new World();
    w.config();
    await run(w, ['--once']);
    expect(w.board.looks).toEqual([{ running: 0, max: 4, repos: ['acme/x', 'acme/y'] }]);
  });

  it('starts a session that reads the backlog in a checkout of the default branch, telling it what to leave out', async () => {
    const w = new World();
    w.config();
    w.board.proposals.push(proposalRow({ id: 1, repo: 'acme/x' }));
    w.board.skip = [{ issue: 9, why: 'it is already picked up and waiting for a session' }];
    const r = await run(w, ['--once']);
    expect(r.code).toBe(0);
    expect(w.gitCalls).toContain(`-C ${HOME}/code/x worktree add --detach -- ${BACKLOG_DIR} origin/main`);
    expect(w.board.proposals[0]!.startedAt).not.toBeNull();
    const s = w.started[0]!;
    expect(s.args.slice(0, 3)).toEqual(['--name', 'acme/x backlog', '-p']);
    expect(s.opts.cwd).toBe(BACKLOG_DIR);
    const prompt = s.args[3]!;
    expect(prompt).toContain('Sam pressed "Find some more" for acme/x');
    expect(prompt).toContain('#9: it is already picked up and waiting for a session');
    expect(prompt).toContain('pr-status.ts propose acme/x --item "#25 | pick up | why this one"');
    expect(prompt).toContain('change nothing on GitHub');
    expect(w.board.looks).toEqual([{ running: 1, max: 4, repos: ['acme/x', 'acme/y'] }]);
  });

  it('carries out answers without a session: labels and picks up, closes with the reason, and finishes the proposal', async () => {
    const w = new World();
    w.config();
    w.board.proposals.push(written());
    await run(w, ['--once']);
    const lines = w.ghCalls.map((c) => c.line);
    expect(lines).toContain('issue edit 25 -R acme/x --add-label in-progress');
    expect(lines).toContain('issue close 11 -R acme/x --comment done by #20\n\nClosed from a backlog proposal on PR Board.');
    expect(lines.some((l) => l.includes(' 3 '))).toBe(false);
    expect(w.board.proposals[0]!.doneAt).not.toBeNull();
    // The picked-up issue gets its own session straight away, as one is free, on design.
    expect(w.board.pickups).toMatchObject([{ repo: 'acme/x', issue: 25, proposalId: 1 }]);
    const s = w.started.find((x) => x.args[1] === 'acme/x#25 pick-up')!;
    expect(s.opts.cwd).toBe(`${HOME}/code/x/.claude/worktrees/issue-25`);
    expect(s.args[3]).toContain('Sam picked up acme/x#25 from the backlog on PR Board, from a proposal that said: small');
    expect(s.args[3]).toContain('--gate design --state working');
    expect(w.ghCalls.every((c) => c.token === 'tok-123')).toBe(true);
  });

  it('hands the proposal back with what GitHub refused, and leaves the note alone then', async () => {
    const w = new World();
    w.config();
    w.ghRefuses = ['issue close 11'];
    w.board.proposals.push(written({ note: 'also #19' }));
    await run(w, ['--once']);
    expect(w.board.proposals[0]).toMatchObject({ doneAt: null, failure: expect.stringMatching(/^Couldn't close #11: .*HTTP 403.* Your note was not acted on\.$/) });
    expect(w.started.some((s) => s.args[1] === 'acme/x backlog')).toBe(false);
  });

  it('with a note, carries out the choices and then starts a session for the note', async () => {
    const w = new World();
    w.config();
    w.board.proposals.push(written({ note: 'also #19, and not #24 yet' }));
    await run(w, ['--once']);
    expect(w.board.proposals[0]).toMatchObject({ doneAt: null, noteStartedAt: expect.any(String) });
    const s = w.started.find((x) => x.args[1] === 'acme/x backlog')!;
    expect(s.opts.cwd).toBe(BACKLOG_DIR);
    expect(s.args[3]).toContain('The note: also #19, and not #24 yet');
    expect(s.args[3]).toContain('#25 Stop hook → pick up');
    expect(s.args[3]).toContain('pr-status.ts pick-up acme/x#<N>');
    expect(s.args[3]).toContain('pr-status.ts proposal-done acme/x');
  });

  it('hands back a proposal, a note or a pick-up whose session ended without doing its part', async () => {
    const w = new World();
    w.config();
    w.board.proposals.push(proposalRow({ id: 1, repo: 'acme/x', startedAt: '2026-11-08T10:05:00.000Z' }));
    w.board.proposals.push(written({ id: 2, repo: 'acme/y', carriedAt: '2026-11-08T10:21:00.000Z', note: 'n', noteStartedAt: '2026-11-08T10:21:00.000Z' }));
    w.board.pickups.push(pickupRow({ id: 7, repo: 'acme/x', issue: 25, startedAt: '2026-11-08T10:22:00.000Z' }));
    const r = await run(w, ['--once']);
    expect(w.board.proposals[0]!.failure).toMatch(/ended without writing a list\. Its output is the newest acme-x-backlog-\*\.log/);
    expect(w.board.proposals[1]!.failure).toMatch(/session for your note ended without saying it was done/);
    expect(w.board.pickups[0]!.failure).toMatch(/ended without writing a first status/);
    expect(r.err).toContain('acme/x#25: handed back to Sam');
    expect(w.started).toEqual([]);
  });

  it('leaves alone a backlog session that is still running', async () => {
    const w = new World();
    w.config();
    w.board.proposals.push(proposalRow({ id: 1, repo: 'acme/x', startedAt: '2026-11-08T10:05:00.000Z' }));
    w.earlier.push({ pid: 900, name: 'acme/x backlog', startedAt: w.now - 3 * MIN });
    await run(w, ['--once']);
    expect(w.board.proposals[0]!.failedAt).toBeNull();
  });

  it('lets answers to work go first, then notes, proposals and pick-ups, while sessions are free', async () => {
    const w = new World();
    w.config({ maxSessions: 2 });
    w.item('acme/x#5');
    w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
    w.answer('acme/x#5', 6);
    w.board.proposals.push(proposalRow({ id: 1, repo: 'acme/y' }));
    w.board.pickups.push(pickupRow({ id: 7, repo: 'acme/x', issue: 25 }));
    const r = await run(w, ['--once']);
    expect(w.started.map((s) => s.args[1])).toEqual(['acme/x#5 answers', 'acme/y backlog']);
    expect(w.board.pickups[0]!.startedAt).toBeNull();
    expect(r.out).toContain('waiting for one to finish before starting acme/x#25: a session for the pick-up');
  });

  it('takes the label off a dropped pick-up and then finishes it', async () => {
    const w = new World();
    w.config();
    w.board.pickups.push(pickupRow({ id: 7, repo: 'acme/x', issue: 25, droppedAt: '2026-11-08T10:22:00.000Z' }));
    await run(w, ['--once']);
    expect(w.ghCalls.map((c) => c.line)).toContain('issue edit 25 -R acme/x --remove-label in-progress');
    expect(w.board.pickups[0]!.doneAt).not.toBeNull();
    expect(w.started).toEqual([]);
  });

  it('gives a proposal back when its session can’t start', async () => {
    const w = new World();
    w.config();
    w.spawnError = new Error('ENOENT');
    w.board.proposals.push(proposalRow({ id: 1, repo: 'acme/x' }));
    const r = await run(w, ['--once']);
    expect(w.board.proposals[0]!.startedAt).toBeNull();
    expect(r.err).toContain('acme/x: Couldn\'t start a session (ENOENT). Gave it back on the board');
  });

  it('with --dry-run, says what it would do with the backlog and changes nothing', async () => {
    const w = new World();
    w.config();
    w.board.proposals.push(written());
    w.board.proposals.push(proposalRow({ id: 2, repo: 'acme/y' }));
    const r = await run(w, ['--once', '--dry-run']);
    expect(r.out).toContain('acme/x: would carry out the answers: #25 pick up, #11 close, #3 later.');
    expect(r.out).toContain('acme/y: would claim the proposal and start a session');
    expect(w.board.posts().map((s) => s.path)).toEqual(['/api/unclaimed']);
    expect(w.ghCalls.some((c) => c.line.startsWith('issue '))).toBe(false);
  });
});

describe('runningSessions and the backlog', () => {
  it('knows pick-up sessions by their issue and backlog sessions by their repo', () => {
    const ps = [
      `  101 05:07 ${CLAUDE} --name acme/x#25 pick-up -p Sam picked up`,
      `  102 01:00 ${CLAUDE} --name acme/x backlog -p Sam pressed`,
      `  103 01:00 ${CLAUDE} --name acme backlog -p nope`,
    ].join('\n');
    expect([...runningSessions(ps, CLAUDE).keys()]).toEqual(['acme/x#25', 'acme/x backlog']);
  });
});
