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
interface Item { kind: 'pr' | 'issue'; branch: string; body: string; comments: Comment[]; labelled: boolean }
interface Started { cmd: string; args: string[]; opts: SpawnOptions; finish: (code: number) => void }

class World {
  items = new Map<string, Item>();
  reactions = new Map<number, string[]>();
  me = 'robot';
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
  ghCalls: { line: string; token: string | undefined }[] = [];
  gitCalls: string[] = [];
  started: Started[] = [];

  config(over: Record<string, unknown> = {}) {
    this.files.set(CONFIG_PATH, JSON.stringify({ repos: [{ repo: 'acme/x', clone: '~/code/x' }, { repo: 'acme/y', clone: '~/code/y' }], ...over }));
  }

  item(ref: string, kind: 'pr' | 'issue' = 'pr', branch = 'feature-a'): Item {
    const it: Item = { kind, branch, body: renderStatus(asking), comments: [], labelled: true };
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
    if (line === 'api user -q .login') return `${this.me}\n`;
    const list = /^api repos\/([^/]+\/[^/]+)\/issues\?labels=on%20sam&state=open&per_page=100 --paginate --slurp$/.exec(line);
    if (list) {
      if (list[1] === 'acme/x' && this.failLists > 0) { this.failLists--; throw new Error('gh: HTTP 502 Bad Gateway'); }
      const rows = [...this.items].filter(([ref, it]) => ref.startsWith(`${list[1]}#`) && it.labelled)
        .map(([ref, it]) => ({ number: Number(ref.split('#')[1]), comments: it.comments.length, ...(it.kind === 'pr' ? { pull_request: {} } : {}) }));
      return JSON.stringify([rows]);
    }
    const comments = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=100 --paginate --slurp$/.exec(line);
    if (comments) {
      const item = this.items.get(`${comments[1]}#${comments[2]}`)!;
      return JSON.stringify([item.comments.map((c) => ({ ...c, reactions: { eyes: (this.reactions.get(c.id) ?? []).length } }))]);
    }
    const item = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(line);
    if (item) {
      const it = this.items.get(`${item[1]}#${item[2]}`)!;
      return JSON.stringify({ state: 'open', body: it.kind === 'pr' ? it.body : 'issue text', ...(it.kind === 'pr' ? { pull_request: {} } : {}) });
    }
    const head = /^api repos\/([^/]+\/[^/]+)\/pulls\/(\d+) -q \.head\.ref$/.exec(line);
    if (head) return `${this.items.get(`${head[1]}#${head[2]}`)!.branch}\n`;
    if (/^api repos\/[^/]+\/[^/]+ -q \.default_branch$/.test(line)) return 'main\n';
    const eyes = /^api repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions\?content=eyes&per_page=100 --paginate --slurp$/.exec(line);
    if (eyes) return JSON.stringify([(this.reactions.get(Number(eyes[1])) ?? []).map((login) => ({ user: { login }, content: 'eyes' }))]);
    const react = /^api -X POST repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions -f content=eyes --include$/.exec(line);
    if (react) {
      const id = Number(react[1]);
      const who = this.reactions.get(id) ?? [];
      const already = who.includes(this.me) || this.lostRace.has(id);
      if (!who.includes(this.me)) this.reactions.set(id, [...who, this.me]);
      return already ? 'HTTP/2.0 200 OK\n\n{}' : 'HTTP/2.0 201 Created\n\n{}';
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
      return [...(this.worktrees.get(clone) ?? [])].map(([b, p]) => `worktree ${p}\nHEAD 0123abcd\nbranch refs/heads/${b}\n`).join('\n');
    }
    if (rest[0] === 'fetch') return '';
    if (rest[0] === 'rev-parse') {
      if (this.localBranches.has(rest[rest.length - 1]!.replace('refs/heads/', ''))) return 'abc\n';
      throw new Error('git rev-parse failed: ');
    }
    if (rest[0] === 'worktree' && rest[1] === 'add') {
      const b = rest.includes('-b') ? rest[rest.indexOf('-b') + 1]! : rest[rest.length - 1]!;
      const path = rest.find((a) => a.startsWith('/'))!;
      this.worktrees.get(clone)!.set(b, path);
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
      let finish: (code: number) => void = () => {};
      const exited = new Promise<number | null>((resolve) => { finish = resolve; });
      world.started.push({ cmd, args, opts, finish });
      return { pid: 4000 + world.started.length, exited };
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
      graceMs: 5 * MIN, maxSessions: 2, pollMs: POLL,
      logDir: `${HOME}/.pr-board/logs`, tokenFile: TOKEN_PATH, claude: CLAUDE, claudeArgs: [],
    });
  });

  it('takes every setting from the file', () => {
    const c = loadConfig(JSON.stringify({
      repos: [{ repo: 'acme/x', clone: '/src/x' }], graceMinutes: 3, maxSessions: 1, pollSeconds: 30,
      logDir: '/var/log/b', tokenFile: '/etc/t', claude: '/opt/claude', claudeArgs: ['--permission-mode', 'acceptEdits'],
    }), HOME, CONFIG_PATH);
    expect(c).toMatchObject({ graceMs: 3 * MIN, maxSessions: 1, pollMs: 30_000, logDir: '/var/log/b', tokenFile: '/etc/t', claude: '/opt/claude', claudeArgs: ['--permission-mode', 'acceptEdits'] });
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
    w.worktrees.get(`${HOME}/code/x`)!.set('feature-a', `${HOME}/code/x/.claude/worktrees/feature-a`);
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
    expect(prompt).toContain(`acme/x#5: https://github.com/acme/x/pull/5#issuecomment-${id}`);
    expect(prompt).toContain(`fingerprint ${statusFingerprint(asking)} matches the current status`);
    expect(prompt).toContain('1. Colour? → change');
    expect(prompt).toContain('no chat memory');
    expect(prompt).toContain('pr-status skill');
    expect(prompt).toContain('pr-status set');
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
    expect(w.gitCalls).toContain(`-C ${HOME}/code/x fetch origin fix/thing`);
    expect(w.gitCalls).toContain(`-C ${HOME}/code/x worktree add --track -b fix/thing ${path} origin/fix/thing`);
    expect(w.started[0]!.opts.cwd).toBe(path);
  });

  it('uses the local branch when there is one but no worktree has it', async () => {
    const w = new World();
    w.config();
    w.item('acme/x#5');
    w.localBranches.add('feature-a');
    w.answer('acme/x#5', 6);
    await run(w, ['--once']);
    expect(w.gitCalls).toContain(`-C ${HOME}/code/x worktree add ${HOME}/code/x/.claude/worktrees/feature-a feature-a`);
  });

  it('creates an issue-N worktree on a new branch from the default branch for an issue', async () => {
    const w = new World();
    w.config();
    w.item('acme/y#7', 'issue');
    w.answer('acme/y#7', 6);
    await run(w, ['--once']);
    const path = `${HOME}/code/y/.claude/worktrees/issue-7`;
    expect(w.gitCalls).toContain(`-C ${HOME}/code/y fetch origin main`);
    expect(w.gitCalls).toContain(`-C ${HOME}/code/y worktree add -b issue-7 ${path} origin/main`);
    expect(w.started[0]!.opts.cwd).toBe(path);
    expect(w.started[0]!.args[1]).toContain('Read the issue');
  });

  it('reuses an issue-N worktree that already exists', async () => {
    const w = new World();
    w.config();
    w.item('acme/y#7', 'issue');
    w.worktrees.get(`${HOME}/code/y`)!.set('issue-7', '/elsewhere/issue-7');
    w.answer('acme/y#7', 6);
    await run(w, ['--once']);
    expect(w.gitCalls.some((c) => c.includes('worktree add'))).toBe(false);
    expect(w.started[0]!.opts.cwd).toBe('/elsewhere/issue-7');
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
    expect(counts.slice(0, 4)).toEqual([1, 1, 1, 2]);
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

  it('stops at startup on a missing or bad config, a missing clone, or a claude it cannot run', async () => {
    const w = new World();
    let r = await run(w, ['--once']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Couldn't read ${CONFIG_PATH}`);

    w.config();
    w.dirs.delete(`${HOME}/code/y`);
    r = await run(w, ['--once']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${HOME}/code/y, the clone of acme/y, isn't a directory`);

    w.dirs.add(`${HOME}/code/y`);
    w.executables.clear();
    r = await run(w, ['--once']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${CLAUDE} isn't a program it can run`);
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
