import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GAVE_UP_ASK, LOOK_DEFAULT, SERVICE_WORKING_ASK, WORKING_ASK, renderAnswer } from '../src/shared/answer.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { parseStatus, renderStatus } from '../src/shared/status.ts';
import type { Status } from '../src/shared/types.ts';
import type { Gh } from '../cli/gh.ts';
import { loadConfig, main, runningSessions, type ServiceDeps, type SpawnOptions } from '../cli/mac-service.ts';

const HOME = '/home/sam';
const CONFIG_PATH = `${HOME}/.pr-board/service.json`;
const TOKEN_PATH = `${HOME}/.config/claude-github/token`;
const CLAUDE = `${HOME}/.local/bin/claude`;
const POLL = 60_000;
const MIN = 60_000;
const WRITTEN = '2026-11-08T10:00:00.000Z';
const asking: Status = { waitingOn: 'owner', since: null, ask: 'look', questions: [{ n: 1, text: 'Colour?', choices: ['leave', 'change'], defaultChoice: 'leave' }], toTest: null, writtenAt: WRITTEN };

interface Comment { id: number; user: { login: string }; body: string; html_url: string; created_at: string; updated_at: string }
interface Item { kind: 'pr' | 'issue'; branch: string; headRepo: string; body: string; comments: Comment[]; labelled: boolean; open: boolean }
interface Reaction { id: number; login: string; content: string }
interface Started { pid: number; cmd: string; args: string[]; opts: SpawnOptions; startedAt: number; alive: boolean; finish: (code: number) => void }

/** ps's elapsed time for ms: mm:ss, hh:mm:ss or d-hh:mm:ss. */
function etime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  const [d, h, m, sec] = [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60];
  return d > 0 ? `${d}-${two(h)}:${two(m)}:${two(sec)}` : h > 0 ? `${two(h)}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

class World {
  items = new Map<string, Item>();
  reactions = new Map<number, Reaction[]>();
  me = 'robot';
  /** From this many "which account" calls on, gh answers as the owner (the token was swapped). */
  ownerFromCall = Infinity;
  userCalls = 0;
  nextReaction = 900;
  failWorktreeAdd = false;
  failStatusWrites = false;
  /** Items whose comments can't be read. */
  poisoned = new Set<string>();
  /** When set, the next session fails to start, the way a missing program does. */
  spawnError: Error | null = null;
  /** Answers another session of the same account claims just before this one does. */
  lostRace = new Set<number>();
  failLists = 0;
  nextId = 100;
  /** The service's clock, in ms. */
  now = Date.parse(WRITTEN) + 30 * MIN;
  files = new Map<string, string>([[TOKEN_PATH, 'tok-123\n']]);
  dirs = new Set<string>([`${HOME}/code/x`, `${HOME}/code/y`]);
  executables = new Set<string>([CLAUDE]);
  marked = new Set<string>([`${HOME}/code/x`, `${HOME}/code/y`]);
  /** Worktrees by clone: branch → path. */
  worktrees = new Map<string, Map<string, string>>([[`${HOME}/code/x`, new Map([['main', `${HOME}/code/x`]])], [`${HOME}/code/y`, new Map([['main', `${HOME}/code/y`]])]]);
  localBranches = new Set<string>();
  /** Worktree paths git lists as prunable (their folder is gone). */
  prunable = new Set<string>();
  ghCalls: { line: string; token: string | undefined }[] = [];
  gitCalls: string[] = [];
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

  item(ref: string, kind: 'pr' | 'issue' = 'pr', branch = 'feature-a'): Item {
    const it: Item = { kind, branch, headRepo: ref.split('#')[0]!, body: kind === 'pr' ? renderStatus(asking) : 'issue text', comments: [], labelled: true, open: true };
    this.items.set(ref, it);
    return it;
  }

  /** An answer written `ago` minutes before the service's clock. */
  answer(ref: string, ago: number, answers: Record<string, string> = { '1': 'change', look: LOOK_DEFAULT }): number {
    const id = this.nextId++;
    const body = renderAnswer(asking, { fingerprint: statusFingerprint(asking), answers, note: '' });
    const at = new Date(this.now - ago * MIN).toISOString();
    const [repo, n] = ref.split('#');
    this.items.get(ref)!.comments.push({ id, user: { login: 'sam-gh' }, body, html_url: `https://github.com/${repo}/pull/${n}#issuecomment-${id}`, created_at: at, updated_at: at });
    return id;
  }

  /** Puts a reaction on a comment, as if made earlier. */
  react(id: number, content: string, login = this.me): void {
    this.reactions.set(id, [...(this.reactions.get(id) ?? []), { id: this.nextReaction++, login, content }]);
  }

  /** The kinds of reaction this account has on a comment. */
  mine(id: number): string[] {
    return (this.reactions.get(id) ?? []).filter((r) => r.login === this.me).map((r) => r.content).sort();
  }

  /** The status the item's text holds now. */
  statusOf(ref: string): Status | null {
    const it = this.items.get(ref)!;
    if (it.kind === 'pr') return parseStatus(it.body);
    const withStatus = it.comments.filter((c) => c.body.includes('<!-- status -->'));
    return withStatus.length > 0 ? parseStatus(withStatus.at(-1)!.body) : null;
  }

  /** A session rewrote the status, as pr-status does. */
  rewrite(ref: string, s: Partial<Status> = {}): void {
    this.items.get(ref)!.body = renderStatus({ ...asking, ask: 'next look', writtenAt: new Date(this.now).toISOString(), ...s });
  }

  claims(): string[] {
    return this.ghCalls.map((c) => c.line).filter((l) => l.includes('-f content=eyes'));
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
    const list = /^api repos\/([^/]+\/[^/]+)\/issues\?labels=on%20sam&state=open&per_page=100 --paginate --slurp$/.exec(line);
    if (list) {
      if (list[1] === 'acme/x' && this.failLists > 0) { this.failLists--; throw new Error('gh: HTTP 502 Bad Gateway'); }
      const rows = [...this.items].filter(([ref, it]) => ref.startsWith(`${list[1]}#`) && it.labelled && it.open)
        .map(([ref, it]) => ({ number: Number(ref.split('#')[1]), comments: it.comments.length, ...(it.kind === 'pr' ? { pull_request: {} } : {}) }));
      return JSON.stringify([rows]);
    }
    const all = /^api repos\/([^/]+\/[^/]+)\/issues\?state=open&per_page=100 --paginate --slurp$/.exec(line);
    if (all) {
      const rows = [...this.items].filter(([ref, it]) => ref.startsWith(`${all[1]}#`) && it.open)
        .map(([ref, it]) => ({
          number: Number(ref.split('#')[1]), comments: it.comments.length, body: it.body, labels: it.labelled ? [{ name: 'on sam' }] : [],
          ...(it.kind === 'pr' ? { pull_request: {} } : {}),
        }));
      return JSON.stringify([rows]);
    }
    const comments = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=100 --paginate --slurp$/.exec(line);
    if (comments) {
      if (this.poisoned.has(`${comments[1]}#${comments[2]}`)) throw new Error('gh: HTTP 500 Internal Server Error');
      const item = this.items.get(`${comments[1]}#${comments[2]}`)!;
      return JSON.stringify([item.comments.map((c) => ({ ...c, reactions: { total_count: (this.reactions.get(c.id) ?? []).length } }))]);
    }
    const item = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(line);
    if (item) {
      const it = this.items.get(`${item[1]}#${item[2]}`)!;
      return JSON.stringify({ state: it.open ? 'open' : 'closed', body: it.body, user: { login: 'robot' }, ...(it.kind === 'pr' ? { pull_request: {} } : {}) });
    }
    const head = /^api repos\/([^/]+\/[^/]+)\/pulls\/(\d+) -q .*head\.ref.*$/.exec(line);
    if (head) {
      const it = this.items.get(`${head[1]}#${head[2]}`)!;
      return `${it.headRepo}\t${it.branch}\n`;
    }
    if (/^api repos\/[^/]+\/[^/]+ -q \.default_branch$/.test(line)) return 'main\n';
    const reactions = /^api repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions\?per_page=100 --paginate --slurp$/.exec(line);
    if (reactions) return JSON.stringify([(this.reactions.get(Number(reactions[1])) ?? []).map((r) => ({ user: { login: r.login }, content: r.content }))]);
    const react = /^api -X POST repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions -f content=(\w+) --include$/.exec(line);
    if (react) {
      const id = Number(react[1]);
      const content = react[2]!;
      const had = (this.reactions.get(id) ?? []).find((r) => r.login === this.me && r.content === content);
      if (had || (content === 'eyes' && this.lostRace.has(id))) {
        if (!had) this.react(id, content);
        return 'HTTP/2.0 200 OK\n\n{}';
      }
      this.react(id, content);
      return `HTTP/2.0 201 Created\n\n{"id": ${this.nextReaction - 1}}`;
    }
    const unreact = /^api -X DELETE repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions\/(\d+)$/.exec(line);
    if (unreact) {
      const id = Number(unreact[1]);
      const list = this.reactions.get(id) ?? [];
      if (!list.some((r) => r.id === Number(unreact[2]))) throw new Error('gh: HTTP 404 Not Found');
      this.reactions.set(id, list.filter((r) => r.id !== Number(unreact[2])));
      return '';
    }
    // Writing the status, as pr-status does.
    const patchPr = /^api -X PATCH repos\/([^/]+\/[^/]+)\/pulls\/(\d+) -f body=([\s\S]*)$/.exec(line);
    if (patchPr) {
      if (this.failStatusWrites) throw new Error('gh: HTTP 502 Bad Gateway');
      this.items.get(`${patchPr[1]}#${patchPr[2]}`)!.body = patchPr[3]!;
      return '{}';
    }
    const postComment = /^api -X POST repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments -f body=([\s\S]*)$/.exec(line);
    if (postComment) {
      if (this.failStatusWrites) throw new Error('gh: HTTP 502 Bad Gateway');
      const at = new Date(this.now).toISOString();
      this.items.get(`${postComment[1]}#${postComment[2]}`)!.comments.push({ id: this.nextId++, user: { login: this.me }, body: postComment[3]!, html_url: 'x', created_at: at, updated_at: at });
      return '{}';
    }
    const patchComment = /^api -X PATCH repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+) -f body=([\s\S]*)$/.exec(line);
    if (patchComment) {
      if (this.failStatusWrites) throw new Error('gh: HTTP 502 Bad Gateway');
      const c = this.items.get(`${patchComment[1]}#${[...this.items].find(([, it]) => it.comments.some((x) => x.id === Number(patchComment[2])))![0].split('#')[1]}`)!
        .comments.find((x) => x.id === Number(patchComment[2]))!;
      c.body = patchComment[3]!;
      c.updated_at = new Date(this.now).toISOString();
      return '{}';
    }
    const label = /^api (-X (POST|DELETE) )?repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels(?:\/(.+)| -f labels\[\]=(.+))$/.exec(line);
    if (label) {
      const it = this.items.get(`${label[3]}#${label[4]}`)!;
      const name = decodeURIComponent(label[5] ?? label[6]!);
      if (name === 'on sam') it.labelled = label[2] === 'POST';
      return '{}';
    }
    if (/^api repos\/[^/]+\/[^/]+\/labels\/.+$/.test(line)) return '{}';
    if (/^api -X POST repos\/[^/]+\/[^/]+\/pulls\/\d+\/requested_reviewers /.test(line)) return '{}';
    throw new Error(`unexpected gh call: ${line}`);
  };

  git: Gh = async (args) => {
    this.gitCalls.push(args.join(' '));
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
  const deps: ServiceDeps = {
    gh: world.gh,
    git: world.git,
    ps: async (args) => {
      if (args.join(' ') !== '-axww -o pid=,etime=,args=') throw new Error(`unexpected ps call: ${args.join(' ')}`);
      return world.ps();
    },
    files: {
      read: (p) => {
        const text = world.files.get(p);
        if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
        return text;
      },
      isDirectory: (p) => world.dirs.has(p),
      isExecutable: (p) => world.executables.has(p),
      mkdir: (p) => { world.dirs.add(p); },
    },
    kill: (pid, signal) => {
      world.signals.push(`${signal} ${pid}`);
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
      graceMs: 5 * MIN, maxSessions: 2, sessionMs: 60 * MIN, pollMs: POLL,
      logDir: `${HOME}/.pr-board/logs`, tokenFile: TOKEN_PATH, claude: CLAUDE, claudeArgs: [],
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
      logDir: '/var/log/b', tokenFile: '/etc/t', claude: '/opt/claude', claudeArgs: ['--permission-mode', 'acceptEdits'],
    }), HOME, CONFIG_PATH);
    expect(c).toMatchObject({ graceMs: 3 * MIN, maxSessions: 1, sessionMs: 20 * MIN, pollMs: 30_000, logDir: '/var/log/b', tokenFile: '/etc/t', claude: '/opt/claude', claudeArgs: ['--permission-mode', 'acceptEdits'] });
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
  it('starts a fresh session in the PR’s worktree for an answer nobody claimed in 5 minutes, and says so in the status', async () => {
    const w = new World();
    w.config({ claudeArgs: ['--permission-mode', 'acceptEdits'] });
    w.item('acme/x#5');
    w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
    const id = w.answer('acme/x#5', 6);
    const r = await run(w, ['--once']);
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([]);
    expect(w.mine(id)).toEqual(['eyes', 'rocket']);
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
    expect(prompt).toContain(`acme/x#5: https://github.com/acme/x/pull/5#issuecomment-${id}`);
    expect(prompt).toContain(`fingerprint ${statusFingerprint(asking)} matches the current status`);
    expect(prompt).toContain('1. Colour? → change');
    expect(prompt).toContain('Follow the pr-status skill under "Answers from the board"');
    expect(prompt).toContain("Don't start the watcher");
    expect(prompt).toContain('never claude');
    expect(prompt).toContain('install dependencies');
    expect(w.statusOf('acme/x#5')).toMatchObject({ waitingOn: 'claude', ask: SERVICE_WORKING_ASK });
    expect(w.items.get('acme/x#5')!.labelled).toBe(false);
    expect(r.out).toContain('acme/x#5: started a session (process 4001)');
    // The service's own GitHub calls run as Claude's account too.
    expect(w.ghCalls.every((c) => c.token === 'tok-123')).toBe(true);
    expect(w.dirs.has(`${HOME}/.pr-board/logs`)).toBe(true);
  });

  it('leaves an answer alone during its grace period, saying so once, and takes it once that has passed', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 1);
    let claimsBefore = -1;
    const r = await run(w, [], (n, _, stop) => { if (n === 3) claimsBefore = w.claims().length; if (n === 5) stop(); });
    expect(r.code).toBe(0);
    expect(claimsBefore).toBe(0);
    expect(w.started).toHaveLength(1);
    expect(w.claims()).toHaveLength(1);
    expect(r.out.match(/acme\/x#5: an answer is waiting; it takes it after 5 min/g)).toHaveLength(1);
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

  it('creates an issue-N worktree on a new branch from the default branch for an issue, and writes its status in a comment', async () => {
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
    expect(w.statusOf('acme/y#7')).toMatchObject({ waitingOn: 'claude', ask: SERVICE_WORKING_ASK });
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
      w.item('acme/x#5').headRepo = 'stranger/x';
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

  describe('a claimed answer is never silently lost', () => {
    it('claims nothing when something fails before the claim, such as making the worktree', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.failWorktreeAdd = true;
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.mine(id)).toEqual([]);
      expect(w.started).toHaveLength(0);
      expect(r.err).toContain('disk full');
    });

    it('takes its 🚀 and 👀 back off when the session fails to start, leaves the status alone, and says so', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
      w.spawnError = new Error('spawn claude ENOENT');
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.claims()).toHaveLength(1);
      expect(w.mine(id)).toEqual([]);
      expect(w.statusOf('acme/x#5')).toMatchObject({ waitingOn: 'owner', ask: 'look' });
      expect(r.err).toContain('spawn claude ENOENT');
      expect(r.err).toContain("Took this account's reactions back off");
      expect(r.out).not.toContain('started a session');
    });

    it('refuses to claim when the token turns out to be the owner’s at the moment of the claim', async () => {
      const w = new World();
      w.config();
      w.ownerFromCall = 2;
      w.item('acme/x#5');
      w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.mine(id)).toEqual([]);
      expect(w.started).toHaveLength(0);
      expect(r.err).toContain("signed in as sam-gh, the board's owner");
    });

    it('takes its 🚀 back off an answer another session claimed first, and leaves it to that one', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      const id = w.answer('acme/x#5', 6);
      w.lostRace.add(id);
      const r = await run(w, ['--once']);
      expect(w.started).toHaveLength(0);
      expect(w.mine(id)).toEqual(['eyes']);
      expect(r.out).toContain('claimed by another session first');
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
    const a = w.answer('acme/x#5', 8);
    const b = w.answer('acme/x#5', 2);
    await run(w, ['--once']);
    expect(w.started).toHaveLength(1);
    expect(w.started[0]!.args[3]).toContain(`issuecomment-${a}`);
    expect(w.started[0]!.args[3]).toContain(`issuecomment-${b}`);
    expect(w.mine(a)).toEqual(['eyes', 'rocket']);
    expect(w.mine(b)).toEqual(['eyes', 'rocket']);
  });

  it('reads nothing more about a labelled item with no comments', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    await run(w, ['--once']);
    expect(w.ghCalls.map((c) => c.line).filter((l) => l.includes('issues/5'))).toEqual([]);
  });

  it('with --dry-run, claims nothing, creates no worktree, starts nothing and writes no status, but says what it would do', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.item('acme/y#7', 'issue');
    w.answer('acme/x#5', 6);
    w.answer('acme/y#7', 6);
    const before = w.items.get('acme/x#5')!.body;
    const r = await run(w, ['--dry-run', '--once']);
    expect(r.code).toBe(0);
    expect(w.ghCalls.some((c) => / -X (POST|PATCH|DELETE) /.test(` ${c.line}`))).toBe(false);
    expect(w.items.get('acme/x#5')!.body).toBe(before);
    expect(w.started).toHaveLength(0);
    expect(w.gitCalls.some((c) => / (fetch|worktree add) /.test(c))).toBe(false);
    expect(w.dirs.has(`${HOME}/.pr-board/logs`)).toBe(false);
    expect(r.out).toContain(`acme/x#5: would create the worktree ${HOME}/code/x/.claude/worktrees/feature-a`);
    expect(r.out).toContain(`acme/x#5: would claim and start: ${CLAUDE} --name "acme/x#5 answers" -p`);
    expect(r.out).toContain('1. Colour? → change');
  });

  it('says at startup how many items it checked for sessions that ended while it was stopped', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5', 'issue');
    w.answer('acme/x#5', 1);
    const r = await run(w, ['--once']);
    expect(r.out).toContain('Checked 1 open item for sessions that ended while it was stopped; none left an item behind.');
  });

  it('says when there is nothing to do', async () => {
    const w = new World();
    w.config();
    const r = await run(w, ['--once']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('No answers waiting');
    expect(r.out).toContain('acme/x: 0 open items carry "on sam"; 0 with comments read for answers.');
  });

  it('keeps going through errors, waiting longer each time up to 5 minutes, and back to the usual wait after', async () => {
    const w = new World();
    w.config();
    w.failLists = 5;
    w.item('acme/y#7', 'issue');
    w.answer('acme/y#7', 6);
    const r = await run(w, [], (n, _, stop) => { if (n === 7) stop(); });
    // One repo failing doesn't keep the others from being served.
    expect(w.started).toHaveLength(1);
    expect(r.sleeps.slice(0, 7)).toEqual([120_000, 240_000, 300_000, 300_000, 300_000, POLL, POLL]);
    expect(r.err).toContain('HTTP 502 Bad Gateway');
    expect(r.code).toBe(0);
  });

  it('starts nothing, and backs off, when it can’t read the process list', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const r = await run(w, ['--once'], undefined, { ps: async () => { throw new Error('ps: not found'); } });
    expect(r.code).toBe(1);
    expect(w.started).toHaveLength(0);
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

  it("refuses to start under the owner's own account", async () => {
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

    it('leaves everything alone when the session handed the item on', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) { w.rewrite('acme/x#5'); w.started[0]!.finish(0); }
        if (n === 4) stop();
      });
      expect(w.mine(id)).toEqual(['eyes', 'rocket']);
      expect(w.statusOf('acme/x#5')).toMatchObject({ waitingOn: 'owner', ask: 'next look' });
      expect(r.out).toContain('acme/x#5: the session handed the item on; its status now waits on owner.');
      expect(w.started).toHaveLength(1);
    });

    it('hands the item to the owner, marking the answer 😕, when the session ended with the status still the service’s, and never takes that answer again', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) w.started[0]!.finish(1);
        if (n === 6) stop();
      });
      expect(w.mine(id)).toEqual(['confused', 'eyes', 'rocket']);
      const status = w.statusOf('acme/x#5')!;
      expect(status).toMatchObject({ waitingOn: 'owner', ask: GAVE_UP_ASK, questions: [] });
      expect(status.toTest).toContain(`acme-x-5-*.log in ${HOME}/.pr-board/logs`);
      expect(w.items.get('acme/x#5')!.labelled).toBe(true);
      expect(r.err).toContain(`acme/x#5: the session ended without handing the item on. Marked https://github.com/acme/x/pull/5#issuecomment-${id} 😕`);
      expect(w.started).toHaveLength(1);

      // Even after a restart it stays away from that answer; a new answer is another matter.
      await run(w, ['--once']);
      expect(w.started).toHaveLength(1);
      w.answer('acme/x#5', 0);
      w.now += 6 * MIN;
      await run(w, ['--once']);
      expect(w.started).toHaveLength(2);
    });

    it('does the same when it could not write its status and the answer is still the current one', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      w.failStatusWrites = true;
      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) { w.failStatusWrites = false; w.started[0]!.finish(1); }
        if (n === 3) stop();
      });
      expect(r.err).toContain(`couldn't set the status to "${SERVICE_WORKING_ASK}"`);
      expect(w.mine(id)).toEqual(['confused', 'eyes', 'rocket']);
      expect(w.statusOf('acme/x#5')).toMatchObject({ waitingOn: 'owner', ask: GAVE_UP_ASK });
    });

    it('checks a session that ended before the next look', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      const gh = w.gh;
      // The session ends as soon as the status saying it works is written.
      w.gh = async (args, opts) => {
        const res = await gh(args, opts);
        if (args.includes('PATCH') && w.started[0]?.alive) w.started[0].finish(1);
        return res;
      };
      await run(w, [], (n, _, stop) => { if (n === 2) stop(); });
      expect(w.mine(id)).toEqual(['confused', 'eyes', 'rocket']);
    });

    it('stops the whole process group of a session that runs past the time limit, then hands the item back', async () => {
      const w = setup({ sessionMinutes: 5 });
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => { if (n === 8) stop(); });
      expect(w.signals).toEqual(['SIGTERM -4001']);
      expect(r.err).toContain('acme/x#5: its session (process 4001) has run for 5 min, past the 5 min limit; stopping it.');
      expect(w.mine(id)).toEqual(['confused', 'eyes', 'rocket']);
      expect(w.statusOf('acme/x#5')).toMatchObject({ ask: GAVE_UP_ASK });
    });

    it('after a restart counts the sessions still running, and checks the items whose sessions ended while it was down', async () => {
      const w = new World();
      w.config({ maxSessions: 1 });
      // A session from before, still running.
      w.item('acme/x#5');
      const earlierAnswer = w.answer('acme/x#5', 12);
      w.react(earlierAnswer, 'rocket');
      w.react(earlierAnswer, 'eyes');
      w.rewrite('acme/x#5', { waitingOn: 'claude', ask: SERVICE_WORKING_ASK, questions: [] });
      w.items.get('acme/x#5')!.labelled = false;
      w.earlier.push({ pid: 7001, name: 'acme/x#5 answers', startedAt: w.now - 10 * MIN });
      // One that ended while the service was down, on an issue, without handing it on.
      w.item('acme/y#7', 'issue');
      w.items.get('acme/y#7')!.labelled = false;
      const dead = w.answer('acme/y#7', 20);
      w.react(dead, 'rocket');
      w.react(dead, 'eyes');
      w.items.get('acme/y#7')!.comments.push({ id: 1, user: { login: 'robot' }, body: renderStatus({ waitingOn: 'claude', since: null, ask: SERVICE_WORKING_ASK, questions: [], toTest: null, writtenAt: new Date(w.now - 15 * MIN).toISOString() }), html_url: 'x', created_at: new Date(w.now - 15 * MIN).toISOString(), updated_at: new Date(w.now - 15 * MIN).toISOString() });
      // An answer a session of the service handled long ago, and one an open session has (👀 alone): both left alone.
      w.item('acme/x#9');
      const handled = w.answer('acme/x#9', 300);
      w.react(handled, 'rocket');
      w.react(handled, 'eyes');
      w.item('acme/x#10', 'issue');
      w.items.get('acme/x#10')!.labelled = false;
      const open = w.answer('acme/x#10', 30);
      w.react(open, 'eyes');
      w.items.get('acme/x#10')!.comments.push({ id: 2, user: { login: 'robot' }, body: renderStatus({ waitingOn: 'claude', since: null, ask: WORKING_ASK, questions: [], toTest: null, writtenAt: new Date(w.now - 29 * MIN).toISOString() }), html_url: 'x', created_at: new Date(w.now - 29 * MIN).toISOString(), updated_at: new Date(w.now - 29 * MIN).toISOString() });
      // Waiting for a place.
      w.item('acme/x#6');
      w.answer('acme/x#6', 20);

      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) w.earlier = [];
        if (n === 3) stop();
      });
      expect(r.out).toContain('Found 1 session of its own still running: acme/x#5.');
      // The issues acme/y#7 and acme/x#10, and the labelled PRs acme/x#9 and acme/x#6; acme/x#5 is still running.
      expect(r.out).toContain('Checked 4 open items for sessions that ended while it was stopped; 1 left an item behind: acme/y#7.');
      expect(w.mine(dead)).toEqual(['confused', 'eyes', 'rocket']);
      expect(w.statusOf('acme/y#7')).toMatchObject({ waitingOn: 'owner', ask: GAVE_UP_ASK });
      expect(w.mine(handled)).toEqual(['eyes', 'rocket']);
      expect(w.mine(open)).toEqual(['eyes']);
      expect(w.statusOf('acme/x#10')).toMatchObject({ ask: WORKING_ASK });
      // The one still running filled the one place until it was gone; then the waiting item started.
      expect(r.out).toContain('acme/x#6: has answers nobody picked up, but 1 session is already running');
      expect(w.started.map((s) => s.args[1])).toEqual(['acme/x#6 answers']);
      // The earlier session ended without handing its item on, so that came back to the owner too.
      expect(w.statusOf('acme/x#5')).toMatchObject({ waitingOn: 'owner', ask: GAVE_UP_ASK });
      expect(r.out).not.toContain('acme/x#9:');
    });
  });

  it('one item that can’t be read does not stop the items after it, and counts toward the back-off', async () => {
    const w = new World();
    w.config({ maxSessions: 3 });
    for (const n of [5, 6, 8]) w.item(`acme/x#${n}`);
    w.poisoned.add('acme/x#6');
    for (const n of [5, 6, 8]) w.answer(`acme/x#${n}`, 6);
    const r = await run(w, [], (n, _, stop) => { if (n === 1) stop(); });
    expect(w.started).toHaveLength(2);
    expect(r.err).toContain("Couldn't read acme/x#6");
    expect(r.sleeps[0]).toBe(120_000);
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
