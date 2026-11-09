import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOOK_DEFAULT, renderAnswer } from '../src/shared/answer.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { renderStatus } from '../src/shared/status.ts';
import type { Status } from '../src/shared/types.ts';
import type { Gh } from '../cli/gh.ts';
import { loadConfig, main, type ServiceDeps, type SpawnOptions } from '../cli/mac-service.ts';

const HOME = '/home/sam';
const CONFIG_PATH = `${HOME}/.pr-board/service.json`;
const TOKEN_PATH = `${HOME}/.config/claude-github/token`;
const CLAUDE = `${HOME}/.local/bin/claude`;
const POLL = 60_000;
const MIN = 60_000;
const WRITTEN = '2026-11-08T10:00:00.000Z';
const asking: Status = { waitingOn: 'owner', since: null, ask: 'look', questions: [{ n: 1, text: 'Colour?', choices: ['leave', 'change'], defaultChoice: 'leave' }], toTest: null, writtenAt: WRITTEN };

interface Comment { id: number; user: { login: string }; body: string; html_url: string; created_at: string; updated_at: string }
interface Item { kind: 'pr' | 'issue'; branch: string; headRepo: string; body: string; comments: Comment[]; labelled: boolean }
interface Started { cmd: string; args: string[]; opts: SpawnOptions; finish: (code: number) => void }

class World {
  items = new Map<string, Item>();
  reactions = new Map<number, string[]>();
  me = 'robot';
  /** From this many "which account" calls on, gh answers as the owner (the token was swapped). */
  ownerFromCall = Infinity;
  userCalls = 0;
  /** The id of each comment's reaction from the service's account. */
  reactionIds = new Map<number, number>();
  nextReaction = 900;
  failWorktreeAdd = false;
  /** Items whose comments can't be read. */
  poisoned = new Set<string>();
  /** Process ids that exist. */
  livePids = new Set<number>();
  signals: string[] = [];
  /** When set, the next session fails to start, the way a missing program does. */
  spawnError: Error | null = null;
  deleted: string[] = [];
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

  config(over: Record<string, unknown> = {}) {
    this.files.set(CONFIG_PATH, JSON.stringify({ repos: [{ repo: 'acme/x', clone: '~/code/x' }, { repo: 'acme/y', clone: '~/code/y' }], ...over }));
  }

  /** Adds a worktree on `branch`, with its folder. */
  worktree(clone: string, branch: string, path: string): void {
    this.worktrees.get(clone)!.set(branch, path);
    this.dirs.add(path);
  }

  item(ref: string, kind: 'pr' | 'issue' = 'pr', branch = 'feature-a'): Item {
    const it: Item = { kind, branch, headRepo: ref.split('#')[0]!, body: renderStatus(asking), comments: [], labelled: true };
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

  posts(): string[] {
    return this.ghCalls.map((c) => c.line).filter((l) => l.includes('-X POST'));
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
      const rows = [...this.items].filter(([ref, it]) => ref.startsWith(`${list[1]}#`) && it.labelled)
        .map(([ref, it]) => ({ number: Number(ref.split('#')[1]), comments: it.comments.length, ...(it.kind === 'pr' ? { pull_request: {} } : {}) }));
      return JSON.stringify([rows]);
    }
    const comments = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=100 --paginate --slurp$/.exec(line);
    if (comments) {
      if (this.poisoned.has(`${comments[1]}#${comments[2]}`)) throw new Error('gh: HTTP 500 Internal Server Error');
      const item = this.items.get(`${comments[1]}#${comments[2]}`)!;
      return JSON.stringify([item.comments.map((c) => ({ ...c, reactions: { eyes: (this.reactions.get(c.id) ?? []).length } }))]);
    }
    const item = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(line);
    if (item) {
      const it = this.items.get(`${item[1]}#${item[2]}`)!;
      return JSON.stringify({ state: 'open', body: it.kind === 'pr' ? it.body : 'issue text', ...(it.kind === 'pr' ? { pull_request: {} } : {}) });
    }
    const head = /^api repos\/([^/]+\/[^/]+)\/pulls\/(\d+) -q .*head\.ref.*$/.exec(line);
    if (head) {
      const it = this.items.get(`${head[1]}#${head[2]}`)!;
      return `${it.headRepo}\t${it.branch}\n`;
    }
    if (/^api repos\/[^/]+\/[^/]+ -q \.default_branch$/.test(line)) return 'main\n';
    const eyes = /^api repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions\?content=eyes&per_page=100 --paginate --slurp$/.exec(line);
    if (eyes) return JSON.stringify([(this.reactions.get(Number(eyes[1])) ?? []).map((login) => ({ user: { login }, content: 'eyes' }))]);
    const react = /^api -X POST repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions -f content=eyes --include$/.exec(line);
    if (react) {
      const id = Number(react[1]);
      const who = this.reactions.get(id) ?? [];
      const already = who.includes(this.me) || this.lostRace.has(id);
      if (!who.includes(this.me)) {
        this.reactions.set(id, [...who, this.me]);
        this.reactionIds.set(id, this.nextReaction++);
      }
      return already ? 'HTTP/2.0 200 OK\n\n{}' : `HTTP/2.0 201 Created\n\n{"id": ${this.reactionIds.get(id)}}`;
    }
    const unreact = /^api -X DELETE repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions\/(\d+)$/.exec(line);
    if (unreact) {
      const id = Number(unreact[1]);
      if (this.reactionIds.get(id) !== Number(unreact[2])) throw new Error('gh: HTTP 404 Not Found');
      this.reactions.set(id, (this.reactions.get(id) ?? []).filter((l) => l !== this.me));
      this.reactionIds.delete(id);
      this.deleted.push(line);
      return '';
    }
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
    files: {
      read: (p) => {
        const text = world.files.get(p);
        if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
        return text;
      },
      isDirectory: (p) => world.dirs.has(p),
      isExecutable: (p) => world.executables.has(p),
      mkdir: (p) => { world.dirs.add(p); },
      write: (p, text) => { world.files.set(p, text); },
    },
    kill: (pid, signal) => {
      if (signal === 0) {
        if (!world.livePids.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        return;
      }
      world.signals.push(`${signal} ${pid}`);
      const group = world.started.find((s, i) => 4001 + i === -pid);
      if (group) group.finish(143);
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
      const finish = (code: number) => { world.livePids.delete(pid); end(code); };
      world.livePids.add(pid);
      world.started.push({ cmd, args, opts, finish });
      const spawned = world.spawnError ? Promise.reject(world.spawnError) : Promise.resolve();
      spawned.catch(() => {});
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
      logDir: `${HOME}/.pr-board/logs`, stateDir: `${HOME}/.pr-board`, tokenFile: TOKEN_PATH, claude: CLAUDE, claudeArgs: [],
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
      logDir: '/var/log/b', stateDir: '/var/lib/b', tokenFile: '/etc/t', claude: '/opt/claude', claudeArgs: ['--permission-mode', 'acceptEdits'],
    }), HOME, CONFIG_PATH);
    expect(c).toMatchObject({ graceMs: 3 * MIN, maxSessions: 1, sessionMs: 20 * MIN, pollMs: 30_000, logDir: '/var/log/b', stateDir: '/var/lib/b', tokenFile: '/etc/t', claude: '/opt/claude', claudeArgs: ['--permission-mode', 'acceptEdits'] });
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
    ['{"repos": [{"repo": "a/x", "clone": "/a"}], "grace": 5}', 'unknown setting "grace"'],
  ])('refuses %s, saying why', (text, why) => {
    expect(() => loadConfig(text, HOME, CONFIG_PATH)).toThrow(why);
    expect(() => loadConfig(text, HOME, CONFIG_PATH)).toThrow(CONFIG_PATH);
  });
});

describe('mac-service', () => {
  it('starts a fresh session in the PR’s worktree for an answer nobody claimed in 5 minutes', async () => {
    const w = new World();
    w.config({ claudeArgs: ['--permission-mode', 'acceptEdits'] });
    w.item('acme/x#5');
    w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
    const id = w.answer('acme/x#5', 6);
    const r = await run(w, ['--once']);
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([]);
    expect(w.reactions.get(id)).toEqual(['robot']);
    expect(w.started).toHaveLength(1);
    const s = w.started[0]!;
    expect(s.cmd).toBe(CLAUDE);
    expect(s.args[0]).toBe('-p');
    expect(s.args.slice(2)).toEqual(['--name', 'x#5 answers', '--permission-mode', 'acceptEdits']);
    expect(s.opts.cwd).toBe(`${HOME}/code/x/.claude/worktrees/feature-a`);
    expect(s.opts.env.GH_TOKEN).toBe('tok-123');
    expect(s.opts.env.PATH).toBe('/usr/bin');
    expect(s.opts.logPath).toMatch(new RegExp(`^${HOME}/\\.pr-board/logs/acme-x-5-.*\\.log$`));
    const prompt = s.args[1]!;
    expect(prompt).toContain("Sam's answers from PR Board to acme/x#5");
    expect(prompt).toContain(`in ${HOME}/code/x/.claude/worktrees/feature-a`);
    expect(prompt).toContain(`acme/x#5: https://github.com/acme/x/pull/5#issuecomment-${id}`);
    expect(prompt).toContain(`fingerprint ${statusFingerprint(asking)} matches the current status`);
    expect(prompt).toContain('1. Colour? → change');
    expect(prompt).toContain('Follow the pr-status skill under "Answers from the board"');
    expect(prompt).toContain("Don't start the watcher");
    expect(prompt).toContain('install dependencies');
    expect(r.out).toContain('Started a session for acme/x#5');
    // The service's own GitHub calls run as Claude's account too.
    expect(w.ghCalls.every((c) => c.token === 'tok-123')).toBe(true);
    expect(w.dirs.has(`${HOME}/.pr-board/logs`)).toBe(true);
  });

  it('leaves an answer alone during its grace period, and takes it once that has passed', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 1);
    let claimsBefore = -1;
    const r = await run(w, [], (n, _, stop) => { if (n === 4) claimsBefore = w.posts().length; if (n === 5) stop(); });
    expect(r.code).toBe(0);
    expect(w.started).toHaveLength(1);
    expect(claimsBefore).toBe(0);
    expect(w.posts()).toHaveLength(1);
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
    expect(w.started[0]!.args[1]).toContain(`in ${path}`);
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
      expect(w.posts()).toHaveLength(0);
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
    expect(w.posts()).toHaveLength(0);
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
    expect(w.posts()).toHaveLength(0);
    expect(r.err).toContain(`${TOKEN_PATH} is missing or empty`);
  });

  describe('a claimed answer is never silently lost', () => {
    it('claims nothing when something fails before the claim, such as making the worktree', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.failWorktreeAdd = true;
      w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.posts()).toHaveLength(0);
      expect(w.started).toHaveLength(0);
      expect(r.err).toContain('disk full');
    });

    it('takes its 👀 back off when the session fails to start, and says so', async () => {
      const w = new World();
      w.config();
      w.item('acme/x#5');
      w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
      w.spawnError = new Error('spawn claude ENOENT');
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.posts()).toHaveLength(1);
      expect(w.deleted).toEqual([`api -X DELETE repos/acme/x/issues/comments/${id}/reactions/900`]);
      expect(w.reactions.get(id)).toEqual([]);
      expect(r.err).toContain('spawn claude ENOENT');
      expect(r.err).toContain('Took this account\'s 👀 back off');
      expect(r.out).not.toContain('Started a session');
    });

    it('refuses to claim when the token turns out to be the owner’s at the moment of the claim', async () => {
      const w = new World();
      w.config();
      w.ownerFromCall = 2;
      w.item('acme/x#5');
      w.worktree(`${HOME}/code/x`, 'feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
      w.answer('acme/x#5', 6);
      const r = await run(w, ['--once']);
      expect(w.posts()).toHaveLength(0);
      expect(w.started).toHaveLength(0);
      expect(r.err).toContain("signed in as sam-gh, the board's owner");
    });
  });

  it('skips an answer another session claimed first', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.lostRace.add(w.answer('acme/x#5', 6));
    const r = await run(w, ['--once']);
    expect(w.started).toHaveLength(0);
    expect(r.out).toContain('already claimed');
  });

  it('starts no more sessions at once than allowed, and starts the next once one finishes', async () => {
    const w = new World();
    w.config({ maxSessions: 2 });
    for (const n of [5, 6, 8]) { w.item(`acme/x#${n}`); w.answer(`acme/x#${n}`, 6); }
    const counts: number[] = [];
    await run(w, [], (n, _, stop) => {
      counts.push(w.started.length);
      if (n === 2) w.started[0]!.finish(0);
      if (n === 4) stop();
    });
    expect(counts.slice(0, 3)).toEqual([2, 2, 3]);
    expect(w.posts()).toHaveLength(3);
  });

  it('never starts a second session for an item whose session is still running', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const counts: number[] = [];
    await run(w, [], (n) => {
      counts.push(w.started.length);
      if (n === 1) w.answer('acme/x#5', 10);
      if (n === 3) w.started[0]!.finish(0);
    });
    // The finished session is checked first (which gives the first answer back), so the next one starts a poll later.
    expect(counts.slice(0, 5)).toEqual([1, 1, 1, 1, 2]);
    expect(w.started).toHaveLength(2);
    expect(w.posts()).toHaveLength(2);
  });

  it('puts every waiting answer on an item into one session', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    const a = w.answer('acme/x#5', 8);
    const b = w.answer('acme/x#5', 2);
    await run(w, ['--once']);
    expect(w.started).toHaveLength(1);
    expect(w.started[0]!.args[1]).toContain(`issuecomment-${a}`);
    expect(w.started[0]!.args[1]).toContain(`issuecomment-${b}`);
  });

  it('reads nothing more about a labelled item with no comments', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    await run(w, ['--once']);
    expect(w.ghCalls.map((c) => c.line).filter((l) => l.includes('issues/5'))).toEqual([]);
  });

  it('with --dry-run, claims nothing, creates no worktree and starts nothing, but says what it would do', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.item('acme/y#7', 'issue');
    w.answer('acme/x#5', 6);
    w.answer('acme/y#7', 6);
    const r = await run(w, ['--dry-run', '--once']);
    expect(r.code).toBe(0);
    expect(w.posts()).toHaveLength(0);
    expect(w.started).toHaveLength(0);
    expect(w.gitCalls.some((c) => / (fetch|worktree add) /.test(c))).toBe(false);
    expect(w.dirs.has(`${HOME}/.pr-board/logs`)).toBe(false);
    expect(r.out).toContain(`Would create the worktree ${HOME}/code/x/.claude/worktrees/feature-a`);
    expect(r.out).toContain(`Would claim and start: ${CLAUDE} -p`);
    expect(r.out).toContain('1. Colour? → change');
    expect(r.out).toContain('Would create the worktree');
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

  it('stops cleanly when asked, leaving its sessions running', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.answer('acme/x#5', 6);
    const stop = new AbortController();
    const r = await run(w, [], (n) => { if (n === 1) stop.abort(); }, { signal: stop.signal });
    expect(r.code).toBe(0);
    expect(r.sleeps).toHaveLength(1);
    expect(r.out).toContain('Stopping; leaving 1 session running');
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
    /** The session rewrote the status, as pr-status does. */
    const rewriteStatus = (w: World) => { w.items.get('acme/x#5')!.body = renderStatus({ ...asking, writtenAt: new Date(w.now).toISOString() }); };
    const state = (w: World) => JSON.parse(w.files.get(`${HOME}/.pr-board/state.json`)!) as { sessions: unknown[]; refused: number[] };

    it('leaves the claim alone when the status was rewritten after the answer', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      await run(w, [], (n, _, stop) => {
        if (n === 1) { rewriteStatus(w); w.started[0]!.finish(0); }
        if (n === 4) stop();
      });
      expect(w.deleted).toEqual([]);
      expect(w.reactions.get(id)).toEqual(['robot']);
      expect(state(w)).toEqual({ sessions: [], refused: [] });
    });

    it('takes the claim back when the status was not rewritten, remembers the answer and never takes it again', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) w.started[0]!.finish(1);
        if (n === 6) stop();
      });
      expect(w.deleted).toEqual([`api -X DELETE repos/acme/x/issues/comments/${id}/reactions/900`]);
      expect(w.reactions.get(id)).toEqual([]);
      expect(w.started).toHaveLength(1);
      expect(w.posts()).toHaveLength(1);
      expect(r.err).toContain(`ended without updating its status, so https://github.com/acme/x/pull/5#issuecomment-${id} is still unanswered`);
      expect(r.err).toContain(w.started[0]!.opts.logPath);
      expect(state(w)).toEqual({ sessions: [], refused: [id] });

      // Even after a restart, with the answer waiting again, it stays away from it.
      const again = await run(w, ['--once']);
      expect(w.started).toHaveLength(1);
      expect(again.code).toBe(0);
    });

    it('records the running session in the state file', async () => {
      const w = setup();
      const id = w.answer('acme/x#5', 6);
      await run(w, ['--once']);
      expect(state(w).sessions).toEqual([{ pid: 4001, ref: 'acme/x#5', claims: [{ answerId: id, reactionId: 900 }], startedAt: w.now, logPath: w.started[0]!.opts.logPath, ended: false }]);
    });

    it('stops the whole process group of a session that runs past the time limit, then checks it', async () => {
      const w = setup({ sessionMinutes: 5 });
      const id = w.answer('acme/x#5', 6);
      await run(w, [], (n, _, stop) => { if (n === 8) stop(); });
      expect(w.signals).toEqual(['SIGTERM -4001']);
      expect(w.deleted).toEqual([`api -X DELETE repos/acme/x/issues/comments/${id}/reactions/900`]);
    });

    it('after a restart counts the sessions still running, and checks the ones that ended', async () => {
      const w = new World();
      w.config({ maxSessions: 1 });
      w.item('acme/x#5');
      w.item('acme/x#6');
      w.item('acme/y#7', 'issue');
      const running = w.answer('acme/x#5', 20);
      const dead = w.answer('acme/y#7', 20);
      w.answer('acme/x#6', 20);
      w.reactions.set(running, ['robot']);
      w.reactions.set(dead, ['robot']);
      w.reactionIds.set(running, 800);
      w.reactionIds.set(dead, 801);
      w.livePids.add(7001);
      const claim = (answerId: number, reactionId: number) => [{ answerId, reactionId }];
      w.files.set(`${HOME}/.pr-board/state.json`, JSON.stringify({
        sessions: [
          { pid: 7001, ref: 'acme/x#5', claims: claim(running, 800), startedAt: w.now - 10 * MIN, logPath: '/logs/a.log', ended: false },
          { pid: 7002, ref: 'acme/y#7', claims: claim(dead, 801), startedAt: w.now - 10 * MIN, logPath: '/logs/b.log', ended: false },
        ],
        refused: [],
      }));
      const r = await run(w, [], (n, _, stop) => {
        if (n === 1) w.livePids.delete(7001);
        if (n === 3) stop();
      });
      expect(r.out).toContain('Remembers 1 session still running from before, and 1 that ended');
      // The running one filled the one place, so the waiting item started nothing until it was gone.
      expect(w.deleted).toContain(`api -X DELETE repos/acme/y/issues/comments/${dead}/reactions/801`);
      expect(w.deleted).toContain(`api -X DELETE repos/acme/x/issues/comments/${running}/reactions/800`);
      expect(w.started.length).toBeGreaterThan(0);
      expect(w.started.every((s) => s.args[1]!.includes('acme/x#6'))).toBe(true);
    });

    it('does not start anything while restored sessions fill the places', async () => {
      const w = new World();
      w.config({ maxSessions: 1 });
      w.item('acme/x#6');
      w.answer('acme/x#6', 20);
      w.livePids.add(7001);
      w.files.set(`${HOME}/.pr-board/state.json`, JSON.stringify({
        sessions: [{ pid: 7001, ref: 'acme/x#5', claims: [], startedAt: w.now - MIN, logPath: '/logs/a.log', ended: false }], refused: [],
      }));
      const r = await run(w, ['--once']);
      expect(w.started).toHaveLength(0);
      expect(r.out).toContain('already running');
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
