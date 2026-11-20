// The always-on service on the Mac. Once a minute it looks, in each repo it is set up for, for the
// owner's answers from the board that no Claude session has claimed within a grace period, claims
// them and starts a fresh Claude session for them in the item's worktree.
//   node cli/mac-service.ts [--config <file>] [--dry-run] [--once]
// The config file is --config, else $PR_BOARD_SERVICE_CONFIG, else ~/.pr-board/service.json.
// It keeps no state of its own: what it has done is on GitHub (reactions on the answers, and the
// statuses it writes), and the sessions it has running are in the process list, found by name. So
// a restart picks up where it left off. It never stops on its own because of errors; it stops on
// SIGTERM or SIGINT and leaves the sessions it started running.
import { spawn as spawnChild } from 'node:child_process';
import { accessSync, appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { OWNER_NAME } from '../src/shared/config.ts';
import { CLAUDE_BOT_KEY, LABEL_ON_OWNER, LABEL_PARKED, PICKUP_GRACE_MS, SERVICE_GRACE_MS } from '../src/shared/names.ts';
import {
  CLAIM_REACTION, GAVE_UP_ASK, GAVE_UP_REACTION, SERVICE_REACTION, SERVICE_WORKING_ASK,
  answersCurrentStatus, codeWrittenStatus, isOwnerAnswer,
} from '../src/shared/answer.ts';
import { parseStatus } from '../src/shared/status.ts';
import { claim, claudeReactions, describe, react, unreact, waitingAnswers, writeCodeStatus, writtenAt, type Found, type RestComment } from './answers.ts';
import { OwnerError, flattenPages, isNotFound, gh as realGh, git as realGit, ps as realPs, readItem, readRef, refString, refuseOwner } from './gh.ts';
import type { Gh, Ref } from './gh.ts';
import { PARALLEL_READS, POLL_MS, backoff, inParallel, message } from './poll.ts';

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
  /** The file holding the GitHub token of Claude's own account. */
  tokenFile: string;
  /** The claude program itself (not a shell function wrapping it). */
  claude: string;
  /** Flags added after the name and the prompt, such as --permission-mode. */
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

/** A session of this service's, as the process list shows it. */
export interface Running { pid: number; elapsedMs: number }

export interface ServiceDeps {
  gh: Gh;
  git: Gh;
  /** Runs ps with these arguments. */
  ps: Gh;
  files: {
    /** Throws when the file can't be read. */
    read: (path: string) => string;
    isDirectory: (path: string) => boolean;
    isExecutable: (path: string) => boolean;
    mkdir: (path: string) => void;
  };
  /** Sends a signal to a process (a negative pid is a whole process group). */
  kill: (pid: number, signal: NodeJS.Signals) => void;
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

const SETTINGS = ['repos', 'graceMinutes', 'maxSessions', 'sessionMinutes', 'pollSeconds', 'logDir', 'tokenFile', 'claude', 'claudeArgs'];

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
    graceMs: num('graceMinutes', SERVICE_GRACE_MS / MIN, (n) => n >= 0, 'a number of minutes, 0 or more') * MIN,
    maxSessions: num('maxSessions', 2, (n) => Number.isInteger(n) && n >= 1, 'a whole number, 1 or more'),
    pollMs: num('pollSeconds', POLL_MS / 1000, (n) => n >= 1, 'a number of seconds, 1 or more') * 1000,
    sessionMs: num('sessionMinutes', 60, (n) => n > 0, 'a number of minutes, more than 0') * MIN,
    logDir: d.logDir === undefined ? join(home, '.pr-board', 'logs') : absolute(d.logDir, 'logDir'),
    tokenFile: d.tokenFile === undefined ? join(home, '.config', 'claude-github', 'token') : absolute(d.tokenFile, 'tokenFile'),
    claude: d.claude === undefined ? join(home, '.local', 'bin', 'claude') : absolute(d.claude, 'claude'),
    claudeArgs: claudeArgs as string[],
  };
}

/** The name a session is started with, which is how the process list tells which item it is for. */
const sessionName = (ref: Ref): string => `${refString(ref)} answers`;

/** ps's elapsed time, [[dd-]hh:]mm:ss, in ms; null when it can't be read. */
function elapsedMs(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return null;
  const [, days = '0', hours = '0', mins, secs] = m;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(mins)) * 60 + Number(secs)) * 1000;
}

/**
 * This service's sessions in `ps -axww -o pid=,etime=,args=`, by item: the processes running
 * `claude` with `--name "<owner/repo#N> answers"` first, as the service starts them.
 */
export function runningSessions(psOutput: string, claude: string): Map<string, Running> {
  const found = new Map<string, Running>();
  const start = `${claude} --name `;
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !m[3]!.startsWith(start)) continue;
    const name = /^(\S+#\d+) answers -p(?: |$)/.exec(m[3]!.slice(start.length));
    const elapsed = elapsedMs(m[2]!);
    if (name && elapsed !== null) found.set(name[1]!, { pid: Number(m[1]), elapsedMs: elapsed });
  }
  return found;
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
    `${OWNER_NAME}'s answers from PR Board to ${refString(ref)}. Nobody picked them up, so the PR Board service on the Mac started this fresh session for them in ${cwd}, claimed them with a 👀 and set the status to "${SERVICE_WORKING_ASK}".`,
    '',
    ...described.flatMap((d) => [d, '']),
    'Follow the pr-status skill under "Answers from the board", which says what a session started this way must do.',
    'End with pr-status set --waiting owner (or nobody), never claude: once this session ends, nobody is left to carry on.',
  ].join('\n');
}

const indent = (text: string) => text.split('\n').map((l) => `    ${l}`).join('\n');

/** An answer claimed for a session, with the ids of this account's 🚀 and 👀 on it, to take them back if the session can't start. */
interface Claimed { found: Found; rocketId: number | null; eyesId: number | null }

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

  // Lines about one item start with it, so grepping the log for "owner/repo#N" gives that item's story.
  const say = (ref: string, line: string) => out(`${ref}: ${line}`);
  const warn = (ref: string, line: string) => err(`${ref}: ${line}`);
  /** What was last said about each item's waiting answers, so a situation that hasn't changed isn't logged every minute. */
  const lastSaid = new Map<string, string>();
  const sayOnce = (ref: string, line: string) => {
    if (lastSaid.get(ref) === line) return;
    lastSaid.set(ref, line);
    say(ref, line);
  };

  // Only in memory, and rebuilt from GitHub and the process list after a restart.
  /** The items whose sessions were running at the last look; null before the first. */
  let previous: Set<string> | null = null;
  /** Items to check (a failed check is tried again): true for one whose session was seen to end, false for one found at startup. */
  const toCheck = new Map<string, boolean>();
  /** Sessions it has asked to stop for running too long, by process: when it asked, or 'forced' once it forced them. */
  const stopping = new Map<number, number | 'forced'>();
  /** Items whose hand-back failed partway in this run, to be finished on a later look. */
  const handBackFailed = new Set<string>();
  /**
   * 🚀s it couldn't take back off answers another session claimed first, by item. While one is there the
   * answer looks like this service's, so the item isn't checked as an ended session's until it is off.
   */
  const strayRockets = new Map<string, { found: Found; reactionId: number | null }[]>();
  let planned = 0;

  const logHint = (ref: Ref) => `Its output is the newest ${ref.owner}-${ref.repo}-${ref.n}-*.log in ${config.logDir}; the service's own log says why it stopped (grep it for ${refString(ref)}).`;

  /**
   * After the service's session for an item has ended: if the item's status is still the one the
   * service wrote as it started the session, or the answer is still current, the session didn't hand
   * the item on. Marks the answer 😕 and hands the item to the owner, saying so in its status, and
   * returns true (in a dry run, says it would). `ended` is false for the check at startup, when most
   * items had no session that just ended.
   */
  async function checkEnded(ref: Ref, ended: boolean): Promise<boolean> {
    const name = refString(ref);
    let item: Awaited<ReturnType<typeof readItem<RestComment>>>;
    try {
      item = await readItem<RestComment>(gh, ref);
    } catch (e) {
      // Only the item itself missing means it is gone; any later failure is tried again at the next look.
      if (!isNotFound(e)) throw e;
      warn(name, 'it is gone (deleted, or moved to another repo); no longer checking it.');
      handBackFailed.delete(name);
      return false;
    }
    if (!item.open) return false;
    const latest = item.comments.filter((c) => isOwnerAnswer(c.user?.login, c.body)).at(-1);
    if (!latest) return false;
    const kinds = await claudeReactions(gh, ref, latest);
    // Without the 🚀 the claim is an open session's, which this service must leave alone.
    if (!kinds.has(SERVICE_REACTION) || !kinds.has(CLAIM_REACTION)) return false;
    const status = parseStatus(item.statusText);
    const kind = codeWrittenStatus(status);
    if (kind === 'gave-up') {
      // Handed back already; but if this run's hand-back failed after the status went up (say, adding the label), finish it.
      if (!handBackFailed.has(name) || item.labels.includes(LABEL_ON_OWNER) || dryRun) return false;
      for (const p of await writeCodeStatus(gh, ref, 'owner', GAVE_UP_ASK, logHint(ref), new Date(deps.now()))) warn(name, p);
      handBackFailed.delete(name);
      warn(name, `finished handing the item back to ${OWNER_NAME}: its status said "${GAVE_UP_ASK}" but the "${LABEL_ON_OWNER}" label hadn't gone on.`);
      return false;
    }
    const current = answersCurrentStatus({ login: latest.user?.login, body: latest.body, createdAt: latest.created_at }, await writtenAt(gh, ref, item));
    if (kind !== 'service-working' && !current) {
      if (ended) say(name, `the session handed the item on; its status now waits on ${status?.waitingOn ?? 'nobody it says'}.`);
      return false;
    }
    if (dryRun) {
      say(name, `the session ended without handing the item on; would mark ${latest.html_url} 😕 and hand it back to ${OWNER_NAME}.`);
      return true;
    }
    await react(gh, { ref, id: latest.id }, GAVE_UP_REACTION);
    try {
      for (const p of await writeCodeStatus(gh, ref, 'owner', GAVE_UP_ASK, logHint(ref), new Date(deps.now()))) warn(name, p);
    } catch (e) {
      handBackFailed.add(name);
      throw e;
    }
    handBackFailed.delete(name);
    warn(name, `the session ended without handing the item on. Marked ${latest.html_url} 😕 and set the status to "${GAVE_UP_ASK}", waiting on ${OWNER_NAME}. This service won't take that answer again. ${logHint(ref)}`);
    return true;
  }

  /** Every open item in the repos that a session of this service could have left: run once at startup, when the process list is all there is. */
  async function itemsToCheckAtStartup(repos: RepoConfig[], live: Map<string, Running>): Promise<Ref[]> {
    const refs: Ref[] = [];
    for (const repo of repos) {
      const rows = flattenPages(await gh(['api', `repos/${repo.owner}/${repo.repo}/issues?state=open&per_page=100`, '--paginate', '--slurp'])) as
        { number: number; comments?: number; body?: string | null; pull_request?: unknown; labels?: { name: string }[] }[];
      for (const row of rows) {
        const ref: Ref = { owner: repo.owner, repo: repo.repo, n: row.number };
        if (live.has(refString(ref)) || row.comments === 0) continue;
        const labels = (row.labels ?? []).map((l) => l.name);
        // A PR's status is in its description; an issue's is in a comment, so any issue not parked might hold one.
        const could = row.pull_request
          ? codeWrittenStatus(parseStatus(row.body ?? '')) === 'service-working' || labels.includes(LABEL_ON_OWNER)
          : !labels.includes(LABEL_PARKED);
        if (could) refs.push(ref);
      }
    }
    return refs;
  }

  /**
   * Stops the sessions that have run too long: asks politely (SIGTERM), and forces it (SIGKILL) if the
   * session is still there a minute later. The check that follows any ended session then runs.
   */
  function stopLongRunning(live: Map<string, Running>): void {
    // Forget processes that have gone, so a reused process id starts afresh.
    const pids = new Set([...live.values()].map((s) => s.pid));
    for (const pid of stopping.keys()) if (!pids.has(pid)) stopping.delete(pid);
    for (const [name, s] of live) {
      const asked = stopping.get(s.pid);
      if (s.elapsedMs < config.sessionMs || asked === 'forced') continue;
      if (dryRun) {
        if (asked === undefined) say(name, `its session (process ${s.pid}) has run for ${Math.floor(s.elapsedMs / MIN)} min; would stop it.`);
        stopping.set(s.pid, deps.now());
        continue;
      }
      if (asked !== undefined && deps.now() - asked < MIN) continue;
      const signal = asked === undefined ? 'SIGTERM' : 'SIGKILL';
      warn(name, asked === undefined
        ? `its session (process ${s.pid}) has run for ${Math.floor(s.elapsedMs / MIN)} min, past the ${config.sessionMs / MIN} min limit; stopping it.`
        : `its session (process ${s.pid}) is still running a minute after being asked to stop; forcing it to stop.`);
      try {
        deps.kill(-s.pid, signal);
        stopping.set(s.pid, asked === undefined ? deps.now() : 'forced');
      } catch (e) {
        // Tried again at the next look.
        warn(name, `couldn't stop process group ${s.pid}: ${message(e)}`);
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
      say(refString(ref), `would create the worktree ${path} on ${isPr ? `the PR's branch ${branch}` : `a new branch ${branch} from the default branch`}.`);
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
    say(refString(ref), `created the worktree ${path}.`);
    return path;
  }

  /** Why sessions can't run in this repo's clone, or null when it is marked as one where Claude acts as its own account. */
  async function markProblem(repo: RepoConfig): Promise<string | null> {
    const marked = await deps.git(['-C', repo.clone, 'config', '--local', '--get', CLAUDE_BOT_KEY]).then((s) => s.trim(), () => '');
    return marked === 'true' ? null
      : `${repo.clone} is not marked ${CLAUDE_BOT_KEY}=true, so a session there would act as ${OWNER_NAME}'s own GitHub account. To let Claude act there under its own account: git -C ${repo.clone} config ${CLAUDE_BOT_KEY} true`;
  }

  /** Takes this account's reactions back off one answer, so the board shows it as waiting again. */
  async function takeBack(name: string, f: Found, ids: (number | null)[], why: string): Promise<void> {
    try {
      for (const id of ids) await unreact(gh, f, id);
      warn(name, `${why} Took this account's reactions back off ${f.url} so a session can pick it up.`);
    } catch (e) {
      warn(name, `${why} Couldn't take this account's reactions off ${f.url} (${message(e)}); take its 🚀 and 👀 off by hand.`);
    }
  }

  /**
   * Finds the worktree and writes the prompt, all before anything is claimed, so an answer this
   * service can't serve stays free for others. Then marks each answer 🚀 and claims it with 👀,
   * starts the session and sets the status to say a Mac session is working on it. If the session
   * can't start, the reactions are taken back.
   */
  async function startSession(repo: RepoConfig, ref: Ref, isPr: boolean, answers: Found[]): Promise<void> {
    const name = refString(ref);
    const unmarked = await markProblem(repo);
    if (unmarked) {
      warn(name, `not starting a session: ${unmarked}`);
      return;
    }
    const token = readToken();
    if (!token) {
      warn(name, `not starting a session: ${config.tokenFile} is missing or empty, so the session couldn't act as Claude's own GitHub account.`);
      return;
    }
    const branch = isPr ? await prBranch(ref) : `issue-${ref.n}`;
    const cwd = await worktreeFor(repo, ref, isPr, branch);
    const promptOf = (some: Found[]) => promptFor(ref, cwd, some.map(describe));
    const logPath = join(config.logDir, `${ref.owner}-${ref.repo}-${ref.n}-${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}.log`);
    // The name comes first, so the process list shows it before the long prompt.
    const argsFor = (prompt: string) => ['--name', sessionName(ref), '-p', prompt, ...config.claudeArgs];
    if (dryRun) {
      planned++;
      say(name, `would claim and start: ${config.claude} --name "${sessionName(ref)}" -p <the prompt below> ${config.claudeArgs.join(' ')}\n  in ${cwd}\n  with GH_TOKEN from ${config.tokenFile}\n  output to ${logPath}\n  prompt:\n${indent(promptOf(answers))}`);
      return;
    }
    deps.files.mkdir(config.logDir);

    // The last check before the claim: the token must not be the owner's, whose 👀 the board ignores.
    await refuseOwner(gh, ownerAdvice);
    const claimed: Claimed[] = [];
    let claimFailed = false;
    for (const f of answers) {
      let rocket: { reactionId: number | null } | null;
      let eyes: { reactionId: number | null } | null;
      try {
        // 🚀 before 👀: a 👀 without a 🚀 is an open session's, so this order never leaves one of ours looking like that.
        rocket = await react(gh, f, SERVICE_REACTION);
        eyes = await claim(gh, f);
      } catch (e) {
        claimFailed = true;
        warn(name, `couldn't claim ${f.url}: ${message(e)}`);
        continue;
      }
      if (eyes) {
        claimed.push({ found: f, rocketId: rocket?.reactionId ?? null, eyesId: eyes.reactionId });
        continue;
      }
      say(name, `${f.url} was claimed by another session first; leaving it to that one.`);
      // The answer is that session's, so a 🚀 left on it must not lead to it being handed back.
      if (rocket) {
        await unreact(gh, f, rocket.reactionId).catch((e: unknown) => {
          warn(name, `couldn't take its 🚀 back off ${f.url} (${message(e)}); will try again at the next look.`);
          strayRockets.set(name, [...(strayRockets.get(name) ?? []), { found: f, reactionId: rocket.reactionId }]);
        });
      }
    }
    if (claimed.length === 0) {
      // GitHub may have taken the 🚀 and 👀 even though its reply was lost; with no session to act on them, check as for one that ended.
      if (claimFailed) toCheck.set(name, true);
      return;
    }

    const args = argsFor(promptOf(claimed.map((c) => c.found)));
    let session: Session;
    try {
      session = deps.spawn(config.claude, args, { cwd, env: { ...deps.env, GH_TOKEN: token }, logPath });
      await session.spawned;
    } catch (e) {
      for (const c of claimed) await takeBack(name, c.found, [c.eyesId, c.rocketId], `Couldn't start a session (${message(e)}).`);
      return;
    }
    planned++;
    // Counted as running from now, so it is checked once it has gone even if that is before the next look.
    previous?.add(name);
    say(name, `started a session (process ${session.pid ?? 'unknown'}) in ${cwd} for ${claimed.map((c) => c.found.url).join(', ')}; its output goes to ${logPath}.`);
    void session.exited.then((code) => say(name, `the session finished (exit code ${code ?? 'unknown'}).`));
    try {
      for (const p of await writeCodeStatus(gh, ref, 'claude', SERVICE_WORKING_ASK, null, new Date(deps.now()))) warn(name, p);
    } catch (e) {
      // The session runs on; if it ends without handing the item on, the answer is still current and the check after it catches that.
      warn(name, `couldn't set the status to "${SERVICE_WORKING_ASK}": ${message(e)}`);
    }
  }

  /** The owner's waiting answers in one repo. Returns how many items had some past their grace period, how many it read, and how many of those failed. */
  async function serveRepo(repo: RepoConfig, live: Map<string, Running>): Promise<{ ripe: number; reads: number; unread: number }> {
    const label = encodeURIComponent(LABEL_ON_OWNER);
    const rows = flattenPages(await gh(['api', `repos/${repo.owner}/${repo.repo}/issues?labels=${label}&state=open&per_page=100`, '--paginate', '--slurp'])) as
      { number: number; comments?: number; pull_request?: unknown }[];
    let ripe = 0;
    let unread = 0;
    // An item with no comments has no answers, so it isn't read any further.
    const readable = rows.filter((r) => r.comments !== 0);
    if (once) {
      out(`${repo.owner}/${repo.repo}: ${rows.length} open ${rows.length === 1 ? 'item carries' : 'items carry'} "${LABEL_ON_OWNER}"; ${readable.length} with comments read for answers.`);
    }
    // Read every item first, several at once; then act on them one at a time, so the session count stays right.
    const toRead = readable.map((row) => ({ row, ref: { owner: repo.owner, repo: repo.repo, n: row.number } satisfies Ref })).filter(({ ref }) => !live.has(refString(ref)));
    const reads = await inParallel(toRead, PARALLEL_READS, ({ ref }) => waitingAnswers(gh, [ref], out));
    for (const [i, { row, ref }] of toRead.entries()) {
      const name = refString(ref);
      // One item that can't be read doesn't keep the rest of the repo from being served.
      const { found: answers, failed: why } = reads[i]!;
      if (why.length > 0) {
        unread++;
        for (const line of why) err(line);
        continue;
      }
      if (answers.length === 0) {
        lastSaid.delete(name);
        continue;
      }
      const oldest = Math.min(...answers.map((f) => Date.parse(f.createdAt)));
      if (deps.now() - oldest < config.graceMs) {
        sayOnce(name, `an answer is waiting; it takes it after ${config.graceMs / MIN} min if no open session does first.`);
        continue;
      }
      ripe++;
      if (live.size + planned >= config.maxSessions) {
        sayOnce(name, `has answers nobody picked up, but ${config.maxSessions} ${config.maxSessions === 1 ? 'session is' : 'sessions are'} already running; it waits for one to finish.`);
        continue;
      }
      lastSaid.delete(name);
      try {
        await startSession(repo, ref, Boolean(row.pull_request), answers);
      } catch (e) {
        warn(name, `couldn't start a session: ${message(e)}`);
      }
    }
    return { ripe, reads: toRead.length, unread };
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

  out(`${dryRun ? 'Dry run: claims nothing, creates nothing, starts nothing, writes no status. ' : ''}Looking every ${config.pollMs / 1000} s in ${repos.map((r) => `${r.owner}/${r.repo}`).join(', ')} for answers unclaimed after ${config.graceMs / MIN} min; at most ${config.maxSessions} sessions at once.`);
  let failures = 0;
  for (;;) {
    planned = 0;
    let failed = false;
    // Items read this look, and how many of them failed.
    let reads = 0;
    let unread = 0;
    let ripe = 0;
    let live: Map<string, Running> | null = null;
    try {
      live = runningSessions(await deps.ps(['-axww', '-o', 'pid=,etime=,args=']), config.claude);
    } catch (e) {
      failed = true;
      err(`Couldn't list the running processes (${message(e)}), so it can't tell which sessions are running; starting none this time.`);
    }
    if (live) {
      let atStartup = 0;
      try {
        if (previous === null) {
          if (live.size > 0) out(`Found ${live.size} ${live.size === 1 ? 'session' : 'sessions'} of its own still running: ${[...live.keys()].join(', ')}.`);
          const refs = await itemsToCheckAtStartup(repos, live);
          atStartup = refs.length;
          for (const ref of refs) if (!toCheck.has(refString(ref))) toCheck.set(refString(ref), false);
        } else {
          for (const name of previous) if (!live.has(name)) toCheck.set(name, true);
        }
        previous = new Set(live.keys());
      } catch (e) {
        failed = true;
        err(`Couldn't look for items its sessions left at startup (${message(e)}); will try again.`);
      }
      // Try again to take off 🚀s left on other sessions' answers.
      for (const [name, left] of [...strayRockets]) {
        const still: typeof left = [];
        for (const r of left) await unreact(gh, r.found, r.reactionId).catch(() => still.push(r));
        if (still.length === 0) {
          strayRockets.delete(name);
          say(name, "took its 🚀 back off the answer another session claimed first.");
        } else strayRockets.set(name, still);
      }
      // A session still running is checked once it has gone; an item with a 🚀 still on another session's answer, once that is off.
      const checked = await inParallel([...toCheck].filter(([name]) => !live.has(name) && !strayRockets.has(name)), PARALLEL_READS, async ([name, ended]) => {
        const ref = readRef(name);
        if (!('owner' in ref)) return { name, ended, left: false, ok: true };
        try {
          const left = await checkEnded(ref, ended);
          toCheck.delete(name);
          return { name, ended, left, ok: true };
        } catch (e) {
          warn(name, `couldn't check whether its session handed the item on (${message(e)}); will try again.`);
          return { name, ended, left: false, ok: false };
        }
      });
      reads += checked.length;
      unread += checked.filter((c) => !c.ok).length;
      if (previous !== null && atStartup > 0) {
        const fromStartup = checked.filter((c) => !c.ended);
        const left = fromStartup.filter((c) => c.left).map((c) => c.name);
        const unread = fromStartup.filter((c) => !c.ok).length;
        out(`Checked ${atStartup} open ${atStartup === 1 ? 'item' : 'items'} for sessions that ended while it was stopped; ${left.length === 0 ? 'none left an item behind' : `${left.length} left an item behind: ${left.join(', ')}`}${unread > 0 ? `; ${unread} couldn't be read and will be checked again` : ''}.`);
      }
      stopLongRunning(live);
      for (const repo of repos) {
        try {
          const served = await serveRepo(repo, live);
          ripe += served.ripe;
          reads += served.reads;
          unread += served.unread;
        } catch (e) {
          failed = true;
          err(`${repo.owner}/${repo.repo}: ${message(e)}`);
        }
      }
    }
    if (once) {
      if (ripe === 0 && !failed && unread === 0) out(`No answers waiting past the ${config.graceMs / MIN} min grace period; nothing to do.`);
      return failed || unread > 0 ? 1 : 0;
    }
    // Back off when the lists couldn't be read, or every item read failed (GitHub refusing reads, say); one bad item alone doesn't.
    failures = failed || (reads > 0 && unread === reads) ? failures + 1 : 0;
    const wait = backoff(config.pollMs, failures);
    if (failures > 0) err(`Trying again in ${wait / 1000} s.`);
    if (deps.signal?.aborted) break;
    await deps.sleep(wait, deps.signal);
    if (deps.signal?.aborted) break;
  }
  out(`Stopping; its sessions carry on (${previous?.size ?? 0} running at the last look).`);
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
    ps: realPs,
    files: {
      read: (p) => readFileSync(p, 'utf8'),
      isDirectory: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
      isExecutable: (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } },
      mkdir: (p) => { mkdirSync(p, { recursive: true }); },
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
