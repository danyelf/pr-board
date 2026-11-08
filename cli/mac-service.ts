// The always-on service on the Mac. Once a minute it looks, in each repo it is set up for, for the
// owner's answers from the board that no Claude session has claimed within a grace period, claims
// them with a 👀 reaction and starts a fresh Claude session for them in the item's worktree.
//   node cli/mac-service.ts [--config <file>] [--dry-run] [--once]
// The config file is --config, else $PR_BOARD_SERVICE_CONFIG, else ~/.pr-board/service.json.
// It never stops on its own because of errors; it stops on SIGTERM or SIGINT and leaves the
// sessions it started running.
import { spawn as spawnChild } from 'node:child_process';
import { accessSync, appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { OWNER_NAME } from '../src/shared/config.ts';
import { CLAUDE_BOT_KEY, LABEL_ON_OWNER, PICKUP_GRACE_MS, SERVICE_GRACE_MS } from '../src/shared/names.ts';
import { answersCurrentStatus } from '../src/shared/answer.ts';
import { claim, describe, statusWrittenAt, unclaim, waitingAnswers, type Found, type RestComment } from './answers.ts';
import { OwnerError, flattenPages, gh as realGh, git as realGit, readItem, readRef, refString, refuseOwner } from './gh.ts';
import type { Gh, Ref } from './gh.ts';
import { backoff, message } from './poll.ts';

const MIN = 60_000;
const USAGE = 'Usage: mac-service [--config <file>] [--dry-run] [--once]';

export interface RepoConfig { owner: string; repo: string; clone: string }

export interface Config {
  repos: RepoConfig[];
  /** How long an answer may wait for an open session before this service starts one. */
  graceMs: number;
  /** The most sessions it has running at once. */
  maxSessions: number;
  pollMs: number;
  /** How long a session may run before it is stopped. */
  sessionMs: number;
  /** Where each session's output goes, one file per session. */
  logDir: string;
  /** Where the service keeps its state file: the sessions it has running, and the answers it won't take again. */
  stateDir: string;
  /** The file holding the GitHub token of Claude's own account. */
  tokenFile: string;
  /** The claude program itself (not a shell function wrapping it). */
  claude: string;
  /** Flags added after the prompt and the name, such as --permission-mode. */
  claudeArgs: string[];
}

export interface SpawnOptions { cwd: string; env: NodeJS.ProcessEnv; logPath: string }

/** A session started in the background: its process id and when it ends (with its exit code, or null). */
export interface Session {
  pid: number | undefined;
  /** Settles when the process has started, and rejects if it couldn't. */
  spawned: Promise<void>;
  exited: Promise<number | null>;
}

/** An answer this service claimed, with the id of its 👀 reaction. */
interface Claimed { found: Found; reactionId: number | null }

/** What the service remembers of a session it started, in its state file. */
interface SessionRecord {
  pid: number;
  /** owner/repo#N */
  ref: string;
  claims: { answerId: number; reactionId: number | null }[];
  startedAt: number;
  logPath: string;
  /** The process is gone; what is left is checking whether it did its job. */
  ended: boolean;
}

/** The state file: one JSON object, written whole. */
interface State {
  sessions: SessionRecord[];
  /** Answers it took back after a session that didn't act on them, and won't take again. */
  refused: number[];
}

/** A session as the running service tracks it. */
interface Tracked extends SessionRecord {
  itemRef: Ref;
  /** Started by an earlier run of the service, so there is no exit event to wait for. */
  restored: boolean;
  /** Asked to stop because it ran too long. */
  stopped: boolean;
  checking: boolean;
}

const REFUSED_KEPT = 500;

export interface ServiceDeps {
  gh: Gh;
  git: Gh;
  files: {
    /** Throws when the file can't be read. */
    read: (path: string) => string;
    isDirectory: (path: string) => boolean;
    isExecutable: (path: string) => boolean;
    mkdir: (path: string) => void;
    /** Replaces the file's contents, all at once or not at all. */
    write: (path: string, text: string) => void;
  };
  /** Sends a signal to a process (a negative pid is a whole process group); signal 0 only checks it is there. Throws, with code ESRCH, when it isn't. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  homedir: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Waits, returning early when `signal` is aborted. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Starts a program detached from this one, its output going to `logPath`. */
  spawn: (command: string, args: string[], opts: SpawnOptions) => Session;
  /** Aborted to ask the service to stop. */
  signal?: AbortSignal;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const SETTINGS = ['repos', 'graceMinutes', 'maxSessions', 'sessionMinutes', 'pollSeconds', 'logDir', 'stateDir', 'tokenFile', 'claude', 'claudeArgs'];

/** Reads the service's config file, filling in the defaults. Throws, naming the file, on anything it can't use. */
export function loadConfig(text: string, home: string, path: string): Config {
  const fail = (why: string): never => { throw new Error(`${path}: ${why}`); };
  const absolute = (value: unknown, key: string): string => {
    if (typeof value !== 'string' || value.trim() === '') return fail(`"${key}" must be a path`);
    const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
    if (!isAbsolute(expanded)) return fail(`"${key}" must be an absolute path (or start with ~/), not "${value}"`);
    return expanded;
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('must hold one JSON object');
  const d = raw as Record<string, unknown>;
  for (const key of Object.keys(d)) if (!SETTINGS.includes(key)) fail(`unknown setting "${key}"; the settings are ${SETTINGS.join(', ')}`);

  const reposShape = '"repos" must be a list of {"repo": "owner/name", "clone": "/path/to/its/main/clone"}, with at least one';
  if (!Array.isArray(d.repos) || d.repos.length === 0) return fail(reposShape);
  const repos: RepoConfig[] = [];
  for (const entry of d.repos as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return fail(reposShape);
    const e = entry as Record<string, unknown>;
    const name = typeof e.repo === 'string' ? /^([^/\s]+)\/([^/\s]+)$/.exec(e.repo) : null;
    if (!name) return fail(`"repo" must look like owner/name, not ${JSON.stringify(e.repo)}`);
    if (repos.some((r) => r.owner === name[1] && r.repo === name[2])) return fail(`${e.repo} appears twice in "repos"`);
    repos.push({ owner: name[1]!, repo: name[2]!, clone: absolute(e.clone, 'clone') });
  }
  const num = (key: string, fallback: number, ok: (n: number) => boolean, what: string): number => {
    if (d[key] === undefined) return fallback;
    const n = d[key];
    return typeof n === 'number' && Number.isFinite(n) && ok(n) ? n : fail(`"${key}" must be ${what}`);
  };
  const claudeArgs = d.claudeArgs ?? [];
  if (!Array.isArray(claudeArgs) || !claudeArgs.every((a) => typeof a === 'string')) return fail('"claudeArgs" must be a list of strings');
  return {
    repos,
    graceMs: num('graceMinutes', SERVICE_GRACE_MS / MIN,(n) => n >= 0, 'a number of minutes, 0 or more') * MIN,
    maxSessions: num('maxSessions', 2, (n) => Number.isInteger(n) && n >= 1, 'a whole number, 1 or more'),
    pollMs: num('pollSeconds', 60, (n) => n >= 1, 'a number of seconds, 1 or more') * 1000,
    sessionMs: num('sessionMinutes', 60, (n) => n > 0, 'a number of minutes, more than 0') * MIN,
    logDir: d.logDir === undefined ? join(home, '.pr-board', 'logs') : absolute(d.logDir, 'logDir'),
    stateDir: d.stateDir === undefined ? join(home, '.pr-board') : absolute(d.stateDir, 'stateDir'),
    tokenFile: d.tokenFile === undefined ? join(home, '.config', 'claude-github', 'token') : absolute(d.tokenFile, 'tokenFile'),
    claude: d.claude === undefined ? join(home, '.local', 'bin', 'claude') : absolute(d.claude, 'claude'),
    claudeArgs: claudeArgs as string[],
  };
}

/**
 * The worktree checked out on `branch`, from `git worktree list --porcelain`, or null. Skips the
 * ones git marks prunable (their folder is gone). Throws if the branch is checked out in the main
 * checkout, which is the first entry: a session must never work there.
 */
function worktreeOn(porcelain: string, branch: string): string | null {
  const blocks = porcelain.split(/\n\s*\n/).map((b) => b.split('\n')).filter((lines) => lines.some((l) => l.startsWith('worktree ')));
  const pathOf = (lines: string[]) => lines.find((l) => l.startsWith('worktree '))!.slice('worktree '.length);
  const main = blocks[0] ? pathOf(blocks[0]) : null;
  for (const lines of blocks) {
    if (!lines.includes(`branch refs/heads/${branch}`) || lines.some((l) => l === 'prunable' || l.startsWith('prunable '))) continue;
    if (pathOf(lines) === main) throw new Error(`the branch ${branch} is checked out in the main checkout ${main}, and a session must not work there`);
    return pathOf(lines);
  }
  return null;
}

/** What the fresh session is told: the answers, as the watcher prints them, and where to act on them. */
function promptFor(ref: Ref, cwd: string, described: string[]): string {
  return [
    `${OWNER_NAME}'s answers from PR Board to ${refString(ref)}. Nobody picked them up, so the PR Board service on the Mac started this fresh session for them in ${cwd} and claimed them with a 👀.`,
    '',
    ...described.flatMap((d) => [d, '']),
    'Follow the pr-status skill under "Answers from the board". Don\'t start the watcher: this session ends when you finish.',
    "The worktree may be new: install dependencies with the repo's package manager before running tests.",
  ].join('\n');
}

const indent = (text: string) => text.split('\n').map((l) => `    ${l}`).join('\n');

export async function main(argv: string[], deps: ServiceDeps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));

  let configPath: string | undefined;
  let dryRun = false;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--once') once = true;
    else if (a === '--config' && argv[i + 1]) configPath = argv[++i];
    else {
      err(USAGE);
      return 1;
    }
  }
  configPath ??= deps.env.PR_BOARD_SERVICE_CONFIG || join(deps.homedir, '.pr-board', 'service.json');

  let config: Config;
  try {
    let text: string;
    try {
      text = deps.files.read(configPath);
    } catch (e) {
      throw new Error(`Couldn't read ${configPath} (${message(e)}). See mac/service.example.json for what goes in it.`);
    }
    config = loadConfig(text, deps.homedir, configPath);
    if (!deps.files.isExecutable(config.claude)) throw new Error(`${configPath}: ${config.claude} isn't a program it can run; set "claude" to the claude program itself`);
  } catch (e) {
    err(message(e));
    return 1;
  }
  if (config.graceMs >= PICKUP_GRACE_MS) {
    err(`The grace period (${config.graceMs / MIN} min) is not shorter than the board's ${PICKUP_GRACE_MS / MIN} min, so the board will show answers as not picked up before this service takes them.`);
  }

  /** Claude's own token, read fresh each time so a replaced file is noticed; null when missing or empty. */
  const readToken = (): string | null => {
    try {
      return deps.files.read(config.tokenFile).trim() || null;
    } catch {
      return null;
    }
  };
  // The service's own GitHub calls, the claim among them, run as Claude's account. With no token they
  // refuse: under launchd gh would otherwise use whichever account it is logged in as, often the owner's.
  const gh: Gh = async (args, opts) => {
    const token = readToken();
    if (!token) throw new Error(`${config.tokenFile} is missing or empty, so there is no token for Claude's own GitHub account`);
    return deps.gh(args, { ...opts, env: { ...deps.env, GH_TOKEN: token } });
  };

  const ownerAdvice = `The token in ${config.tokenFile} is the owner's; put Claude's own token there.`;
  try {
    await refuseOwner(gh, ownerAdvice);
  } catch (e) {
    if (e instanceof OwnerError) {
      err(e.message);
      return 1;
    }
    err(`Couldn't tell which account the token in ${config.tokenFile} belongs to (${message(e)}); going on anyway.`);
  }

  const tracked = new Map<string, Tracked>();
  const refused = new Set<number>();
  let planned = 0;
  const statePath = join(config.stateDir, 'state.json');
  const live = () => [...tracked.values()].filter((t) => !t.ended).length;

  const alive = (pid: number): boolean => {
    try {
      deps.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };

  /** Writes the sessions it is tracking and the answers it won't take again. A dry run keeps no state. */
  function saveState(): void {
    if (dryRun) return;
    const state: State = {
      sessions: [...tracked.values()].map(({ pid, ref, claims, startedAt, logPath, ended }) => ({ pid, ref, claims, startedAt, logPath, ended })),
      refused: [...refused].slice(-REFUSED_KEPT),
    };
    try {
      deps.files.mkdir(config.stateDir);
      deps.files.write(statePath, JSON.stringify(state, null, 2));
    } catch (e) {
      err(`Couldn't write ${statePath} (${message(e)}); after a restart it won't remember its sessions or the answers it gave back.`);
    }
  }

  /** Reads the state file left by an earlier run. Sessions whose process is gone are marked ended, to be checked. */
  function loadState(): void {
    let text: string;
    try {
      text = deps.files.read(statePath);
    } catch {
      return;
    }
    let state: Partial<State>;
    try {
      state = JSON.parse(text) as Partial<State>;
    } catch {
      err(`${statePath} isn't valid JSON, so it is starting without it. Sessions it started before may still be running.`);
      return;
    }
    for (const id of state.refused ?? []) refused.add(id);
    if (dryRun) return;
    let running = 0;
    let gone = 0;
    for (const rec of state.sessions ?? []) {
      const itemRef = readRef(rec.ref);
      if (!('owner' in itemRef)) continue;
      const ended = rec.ended || !alive(rec.pid);
      tracked.set(rec.ref, { ...rec, ended, itemRef, restored: true, stopped: false, checking: false });
      if (ended) gone++;
      else running++;
    }
    if (running + gone > 0) out(`Remembers ${running} ${running === 1 ? 'session' : 'sessions'} still running from before, and ${gone} that ended.`);
  }

  /**
   * After a session ends: if the item's status wasn't rewritten after the answer, the session did
   * nothing about it. Takes this account's 👀 back off, so the board shows "Answered, not picked up"
   * again, and remembers the answer so it isn't taken a second time.
   */
  async function checkEnded(t: Tracked): Promise<void> {
    const item = await readItem<RestComment>(gh, t.itemRef);
    const writtenAt = item.open ? await statusWrittenAt(gh, t.itemRef, item) : null;
    for (const claimed of [...t.claims]) {
      const c = item.comments.find((x) => x.id === claimed.answerId);
      if (c && item.open && answersCurrentStatus({ login: c.user?.login, body: c.body, createdAt: c.created_at }, writtenAt)) {
        await unclaim(gh, { ref: t.itemRef, id: claimed.answerId }, claimed.reactionId);
        refused.add(claimed.answerId);
        err(`The session for ${t.ref} ended without updating its status, so ${c.html_url} is still unanswered. Took this account's 👀 back off it, so the board shows "Answered, not picked up" again; this service won't take that answer again. The session's output is in ${t.logPath}.`);
      }
      t.claims = t.claims.filter((x) => x !== claimed);
    }
  }

  /** Runs the check for a session that has ended, and forgets the session once it is done. A failed check is tried again on the next poll. */
  async function settle(t: Tracked): Promise<void> {
    if (t.checking) return;
    t.checking = true;
    try {
      await checkEnded(t);
      tracked.delete(t.ref);
    } catch (e) {
      err(`Couldn't check whether the session for ${t.ref} did its job (${message(e)}); will try again.`);
    } finally {
      t.checking = false;
      saveState();
    }
  }

  /** Notices restored sessions that have ended, settles ended ones, and stops those that ran too long. */
  async function sweep(): Promise<void> {
    for (const t of [...tracked.values()]) {
      if (!t.ended && t.restored && !alive(t.pid)) {
        t.ended = true;
        out(`The session for ${t.ref} (process ${t.pid}) is gone; its output is in ${t.logPath}.`);
      }
      if (t.ended) {
        await settle(t);
      } else if (!t.stopped && deps.now() - t.startedAt >= config.sessionMs) {
        t.stopped = true;
        err(`The session for ${t.ref} has run for ${config.sessionMs / MIN} min; stopping it. Its output is in ${t.logPath}.`);
        try {
          deps.kill(-t.pid, 'SIGTERM');
        } catch (e) {
          err(`Couldn't stop process group ${t.pid}: ${message(e)}`);
        }
      }
    }
  }

  /** The PR's branch. Throws if it comes from another repo (a fork) or its name could be read as an option. */
  async function prBranch(ref: Ref): Promise<string> {
    const head = (await gh(['api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.n}`, '-q', '(.head.repo.full_name // "") + "\t" + .head.ref'])).trim();
    const [from = '', branch = ''] = head.split('\t');
    if (from.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()) throw new Error(`its branch comes from ${from || 'a repo that is gone'}, not ${ref.owner}/${ref.repo}; a session only works on branches in the repo itself`);
    if (branch === '' || branch.startsWith('-')) throw new Error(`its branch name ${JSON.stringify(branch)} is empty or starts with "-"`);
    return branch;
  }

  async function worktreeFor(repo: RepoConfig, ref: Ref, isPr: boolean, branch: string): Promise<string> {
    const found = worktreeOn(await deps.git(['-C', repo.clone, 'worktree', 'list', '--porcelain']), branch);
    if (found) {
      if (!deps.files.isDirectory(found)) throw new Error(`the worktree ${found} for ${branch} isn't a directory`);
      return found;
    }
    const path = join(repo.clone, '.claude', 'worktrees', branch);
    if (dryRun) {
      out(`Would create the worktree ${path} on ${isPr ? `the PR's branch ${branch}` : `a new branch ${branch} from the default branch`}.`);
      return path;
    }
    const hasLocal = await deps.git(['-C', repo.clone, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    if (isPr) {
      await deps.git(['-C', repo.clone, 'fetch', '--', 'origin', branch]);
      await deps.git(hasLocal
        ? ['-C', repo.clone, 'worktree', 'add', '--', path, branch]
        : ['-C', repo.clone, 'worktree', 'add', '--track', '-b', branch, '--', path, `origin/${branch}`]);
    } else {
      const base = (await gh(['api', `repos/${ref.owner}/${ref.repo}`, '-q', '.default_branch'])).trim();
      await deps.git(['-C', repo.clone, 'fetch', '--', 'origin', base]);
      await deps.git(hasLocal
        ? ['-C', repo.clone, 'worktree', 'add', '--', path, branch]
        : ['-C', repo.clone, 'worktree', 'add', '--no-track', '-b', branch, '--', path, `origin/${base}`]);
    }
    out(`Created the worktree ${path} for ${refString(ref)}.`);
    return path;
  }

  /** Why sessions can't run in this repo's clone, or null when it is marked as one where Claude acts as its own account. */
  async function markProblem(repo: RepoConfig): Promise<string | null> {
    const marked = await deps.git(['-C', repo.clone, 'config', '--local', '--get', CLAUDE_BOT_KEY]).then((s) => s.trim(), () => '');
    return marked === 'true' ? null
      : `${repo.clone} is not marked ${CLAUDE_BOT_KEY}=true, so a session there would act as ${OWNER_NAME}'s own GitHub account. To let Claude act there under its own account: git -C ${repo.clone} config ${CLAUDE_BOT_KEY} true`;
  }

  /** Takes this account's 👀 back off answers it claimed but can't serve, so the board shows them as waiting again. */
  async function giveBack(claims: Claimed[], why: string): Promise<void> {
    for (const c of claims) {
      try {
        await unclaim(gh, c.found, c.reactionId);
        err(`${why} Took this account's 👀 back off ${c.found.url} so a session can pick it up.`);
      } catch (e) {
        err(`${why} Couldn't take this account's 👀 off ${c.found.url} (${message(e)}); take it off by hand.`);
      }
    }
  }

  /**
   * Finds the worktree and writes the prompt, all before anything is claimed, so an answer this
   * service can't serve stays free for others. Then claims the answers and starts the session. If the
   * session can't start, the claim is given back.
   */
  async function startSession(repo: RepoConfig, ref: Ref, isPr: boolean, answers: Found[]): Promise<void> {
    const name = refString(ref);
    const unmarked = await markProblem(repo);
    if (unmarked) {
      err(`Not starting a session for ${name}: ${unmarked}`);
      return;
    }
    const token = readToken();
    if (!token) {
      err(`Not starting a session for ${name}: ${config.tokenFile} is missing or empty, so the session couldn't act as Claude's own GitHub account.`);
      return;
    }
    const branch = isPr ? await prBranch(ref) : `issue-${ref.n}`;
    const cwd = await worktreeFor(repo, ref, isPr, branch);
    const described = new Map<number, string>();
    for (const f of answers) described.set(f.id, await describe(gh, f));
    const promptOf = (some: Found[]) => promptFor(ref, cwd, some.map((f) => described.get(f.id)!));
    const logPath = join(config.logDir, `${ref.owner}-${ref.repo}-${ref.n}-${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}.log`);
    const argsFor = (prompt: string) => ['-p', prompt, '--name', `${ref.repo}#${ref.n} answers`, ...config.claudeArgs];
    if (dryRun) {
      planned++;
      const args = argsFor(promptOf(answers));
      out(`Would claim and start: ${config.claude} -p <the prompt below> ${args.slice(2).join(' ')}\n  in ${cwd}\n  with GH_TOKEN from ${config.tokenFile}\n  output to ${logPath}\n  prompt:\n${indent(args[1]!)}`);
      return;
    }
    deps.files.mkdir(config.logDir);

    // The last check before the claim: the token must not be the owner's, whose 👀 the board ignores.
    await refuseOwner(gh, ownerAdvice);
    const claimed: Claimed[] = [];
    for (const f of answers) {
      try {
        const got = await claim(gh, f);
        if (got) claimed.push({ found: f, reactionId: got.reactionId });
        else out(`${f.url} was already claimed by another session; leaving it to that one.`);
      } catch (e) {
        err(`Couldn't claim ${f.url}: ${message(e)}`);
      }
    }
    if (claimed.length === 0) return;

    const args = argsFor(promptOf(claimed.map((c) => c.found)));
    let session: Session;
    try {
      session = deps.spawn(config.claude, args, { cwd, env: { ...deps.env, GH_TOKEN: token }, logPath });
      await session.spawned;
    } catch (e) {
      await giveBack(claimed, `Couldn't start a session for ${name} (${message(e)}).`);
      return;
    }
    if (session.pid === undefined) {
      await giveBack(claimed, `Started a session for ${name} but got no process id for it.`);
      return;
    }
    const t: Tracked = {
      pid: session.pid, ref: name, claims: claimed.map((c) => ({ answerId: c.found.id, reactionId: c.reactionId })), startedAt: deps.now(), logPath,
      ended: false, itemRef: ref, restored: false, stopped: false, checking: false,
    };
    tracked.set(name, t);
    saveState();
    out(`Started a session for ${name} (process ${session.pid}) in ${cwd}; its output goes to ${logPath}.`);
    void session.exited.then(async (code) => {
      t.ended = true;
      out(`The session for ${name} finished (exit code ${code ?? 'unknown'}); its output is in ${logPath}.`);
      saveState();
      await settle(t);
    });
  }

  /** The owner's waiting answers in one repo. Returns how many items had some past their grace period, and whether reading any item failed. */
  async function serveRepo(repo: RepoConfig): Promise<{ ripe: number; failed: boolean }> {
    const label = encodeURIComponent(LABEL_ON_OWNER);
    const rows = flattenPages(await gh(['api', `repos/${repo.owner}/${repo.repo}/issues?labels=${label}&state=open&per_page=100`, '--paginate', '--slurp'])) as
      { number: number; comments?: number; pull_request?: unknown }[];
    let ripe = 0;
    let failed = false;
    // An item with no comments has no answers, so it isn't read any further.
    const readable = rows.filter((r) => r.comments !== 0);
    if (once) {
      out(`${repo.owner}/${repo.repo}: ${rows.length} open ${rows.length === 1 ? 'item carries' : 'items carry'} "${LABEL_ON_OWNER}"; ${readable.length} with comments read for answers.`);
    }
    for (const row of readable) {
      const ref: Ref = { owner: repo.owner, repo: repo.repo, n: row.number };
      const name = refString(ref);
      if (tracked.has(name)) continue;
      // One item that can't be read doesn't keep the rest of the repo from being served.
      let answers: Found[];
      try {
        answers = (await waitingAnswers(gh, [ref], out)).filter((f) => !refused.has(f.id));
      } catch (e) {
        failed = true;
        err(`Couldn't read ${name}: ${message(e)}`);
        continue;
      }
      if (!answers.some((f) => deps.now() - Date.parse(f.createdAt) >= config.graceMs)) continue;
      ripe++;
      if (live() + planned >= config.maxSessions) {
        out(`${name} has answers nobody picked up, but ${config.maxSessions} ${config.maxSessions === 1 ? 'session is' : 'sessions are'} already running; it waits for one to finish.`);
        continue;
      }
      try {
        await startSession(repo, ref, Boolean(row.pull_request), answers);
      } catch (e) {
        err(`Couldn't start a session for ${name}: ${message(e)}`);
      }
    }
    return { ripe, failed };
  }

  // A repo it can't serve is logged once and left out; the others carry on.
  const repos: RepoConfig[] = [];
  for (const r of config.repos) {
    const why = !deps.files.isDirectory(r.clone) ? `${r.clone}, the clone of ${r.owner}/${r.repo}, isn't a directory` : await markProblem(r);
    if (why) err(`Skipping ${r.owner}/${r.repo}: ${why}`);
    else repos.push(r);
  }
  if (repos.length === 0) {
    err('No repo is left to serve.');
    return 1;
  }

  loadState();
  out(`${dryRun ? 'Dry run: claims nothing, creates nothing, starts nothing. ' : ''}Looking every ${config.pollMs / 1000} s in ${repos.map((r) => `${r.owner}/${r.repo}`).join(', ')} for answers unclaimed after ${config.graceMs / MIN} min; at most ${config.maxSessions} sessions at once.`);
  let failures = 0;
  for (;;) {
    planned = 0;
    await sweep();
    let failed = false;
    let ripe = 0;
    for (const repo of repos) {
      try {
        const served = await serveRepo(repo);
        ripe += served.ripe;
        failed ||= served.failed;
      } catch (e) {
        failed = true;
        err(`${new Date(deps.now()).toISOString()} ${repo.owner}/${repo.repo}: ${message(e)}`);
      }
    }
    if (once) {
      if (ripe === 0 && !failed) out(`No answers waiting past the ${config.graceMs / MIN} min grace period; nothing to do.`);
      return failed ? 1 : 0;
    }
    failures = failed ? failures + 1 : 0;
    const wait = backoff(config.pollMs, failures);
    if (failures > 0) err(`Trying again in ${wait / 1000} s.`);
    if (deps.signal?.aborted) break;
    await deps.sleep(wait, deps.signal);
    if (deps.signal?.aborted) break;
  }
  out(`Stopping; leaving ${live()} ${live() === 1 ? 'session' : 'sessions'} running.`);
  return 0;
}

function spawnDetached(command: string, args: string[], opts: SpawnOptions): Session {
  const fd = openSync(opts.logPath, 'a');
  try {
    const child = spawnChild(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', (e) => {
        appendFileSync(opts.logPath, `\nCouldn't start ${command}: ${e.message}\n`);
        resolve(null);
      });
    });
    return { pid: child.pid, spawned, exited };
  } finally {
    closeSync(fd);
  }
}

if (import.meta.main) {
  const stop = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => stop.abort());
  const stamp = (line: string) => `${new Date().toISOString()} ${line}`;
  process.exitCode = await main(process.argv.slice(2), {
    gh: realGh,
    git: realGit,
    files: {
      read: (p) => readFileSync(p, 'utf8'),
      isDirectory: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
      isExecutable: (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } },
      mkdir: (p) => { mkdirSync(p, { recursive: true }); },
      write: (p, text) => {
        const temporary = `${p}.tmp`;
        writeFileSync(temporary, text);
        renameSync(temporary, p);
      },
    },
    kill: (pid, signal) => { process.kill(pid, signal); },
    homedir: homedir(),
    env: process.env,
    now: Date.now,
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
    spawn: spawnDetached,
    signal: stop.signal,
    out: (l) => console.log(stamp(l)),
    err: (l) => console.error(stamp(l)),
  });
}
