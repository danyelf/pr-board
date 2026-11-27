// The always-on service on the Mac. Once a minute it asks the board for the owner's answers that no
// Claude session has claimed within a grace period, claims them there and starts a fresh Claude
// session for them in the item's worktree.
//   node cli/mac-service.ts [--config <file>] [--dry-run] [--once]
// The config file is --config, else $PR_BOARD_SERVICE_CONFIG, else ~/.pr-board/service.json.
// It keeps no state of its own: what it has claimed is on the board, and the sessions it has running
// are in the process list, found by name. So a restart picks up where it left off. It never stops on
// its own because of errors; it stops on SIGTERM or SIGINT and leaves the sessions it started running.
import { spawn as spawnChild } from 'node:child_process';
import { accessSync, appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { OWNER_NAME } from '../src/shared/config.ts';
import { CLAUDE_BOT_KEY, GAVE_UP_ASK, LABEL_IN_PROGRESS, PICKUP_GRACE_MS, SERVICE_GRACE_MS, SERVICE_WORKING_ASK, SESSION_LIMIT_MS } from '../src/shared/names.ts';
import { CLOSE, PICK_UP, isAsked, isUnderWay, pickupReason, type Pickup, type Proposal, type Skip } from '../src/shared/backlog.ts';
import { Refused, itemKey, recordNumber, type Found, type WorkRecord } from '../src/shared/work.ts';
import { describe } from './answers.ts';
import { notePrompt, pickupPrompt, proposalPrompt } from './backlog-prompts.ts';
import { closeComment, pickUp } from './pickup.ts';
import { BoardError, boardCall, realBoardDeps, where, type BoardDeps } from './board.ts';
import { OwnerError, gh as realGh, git as realGit, ps as realPs, refString, refuseOwner } from './gh.ts';
import type { Gh, Ref } from './gh.ts';
import { message } from '../src/shared/helpers.ts';
import { POLL_MS, backoff } from './poll.ts';

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
  /** The file holding a token from `claude setup-token`, given to each session as CLAUDE_CODE_OAUTH_TOKEN; null to use claude's own sign-in. */
  claudeTokenFile: string | null;
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
  /** How it reaches the board, signed in with the service token. */
  board: BoardDeps;
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

const SETTINGS = ['repos', 'graceMinutes', 'maxSessions', 'sessionMinutes', 'pollSeconds', 'logDir', 'tokenFile', 'claudeTokenFile', 'claude', 'claudeArgs'];

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
    maxSessions: num('maxSessions', 4, (n) => Number.isInteger(n) && n >= 1, 'a whole number, 1 or more'),
    pollMs: num('pollSeconds', POLL_MS / 1000, (n) => n >= 1, 'a number of seconds, 1 or more') * 1000,
    sessionMs: num('sessionMinutes', SESSION_LIMIT_MS / MIN, (n) => n > 0, 'a number of minutes, more than 0') * MIN,
    logDir: d.logDir === undefined ? join(home, '.pr-board', 'logs') : absolute(d.logDir, 'logDir'),
    tokenFile: d.tokenFile === undefined ? join(home, '.config', 'claude-github', 'token') : absolute(d.tokenFile, 'tokenFile'),
    claudeTokenFile: d.claudeTokenFile == null ? null : absolute(d.claudeTokenFile, 'claudeTokenFile'),
    claude: d.claude === undefined ? join(home, '.local', 'bin', 'claude') : absolute(d.claude, 'claude'),
    claudeArgs: claudeArgs as string[],
  };
}

/** The name a session is started with, which is how the process list tells which item it is for. */
const sessionName = (ref: Ref): string => `${refString(ref)} answers`;
/** A session that starts a picked-up issue goes by the issue, as an answers session does, so the two never run side by side. */
const pickupSessionName = (repo: string, n: number): string => `${itemKey(repo, n)} pick-up`;
/** A session for a repo's proposal (reading its backlog, or acting on the note), and how the process list knows it. */
export const backlogKey = (repo: string): string => `${repo} backlog`;

/** ps's elapsed time, [[dd-]hh:]mm:ss, in ms; null when it can't be read. */
function elapsedMs(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return null;
  const [, days = '0', hours = '0', mins, secs] = m;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(mins)) * 60 + Number(secs)) * 1000;
}

/**
 * This service's sessions in `ps -axww -o pid=,etime=,args=`: the processes running `claude` with
 * `--name "<owner/repo#N> answers"` or `"<owner/repo#N> pick-up"` first, by item, and those with
 * `--name "<owner/repo> backlog"`, by that name.
 */
export function runningSessions(psOutput: string, claude: string): Map<string, Running> {
  const found = new Map<string, Running>();
  const start = `${claude} --name `;
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !m[3]!.startsWith(start)) continue;
    const rest = m[3]!.slice(start.length);
    const item = /^(\S+#\d+) (?:answers|pick-up) -p(?: |$)/.exec(rest);
    const backlog = /^([^\s#/]+\/[^\s#/]+) backlog -p(?: |$)/.exec(rest);
    const key = item ? item[1]! : backlog ? backlogKey(backlog[1]!) : null;
    const elapsed = elapsedMs(m[2]!);
    if (key && elapsed !== null) found.set(key, { pid: Number(m[1]), elapsedMs: elapsed });
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
function promptFor(ref: Ref, cwd: string, described: string): string {
  return [
    `${OWNER_NAME}'s answers from PR Board to ${refString(ref)}. Nobody picked them up, so the PR Board service on the Mac started this fresh session for them in ${cwd}, after claiming them on the board, which set the ask to "${SERVICE_WORKING_ASK}".`,
    '',
    described,
    '',
    'Follow the pr-status skill under "Answers from the board", which says what a session started this way must do.',
    'End with pr-status set --state paused, complete or parked, never working: once this session ends, nobody is left to carry on.',
  ].join('\n');
}

const indent = (text: string) => text.split('\n').map((l) => `    ${l}`).join('\n');

/** The item a record is known by: its PR when it has one, otherwise its issue. Null for a repo name it can't read. */
function refOf(record: WorkRecord): Ref | null {
  const [owner, repo, ...rest] = record.repo.split('/');
  return owner && repo && rest.length === 0 ? { owner, repo, n: recordNumber(record) } : null;
}

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

  /** A token file's contents, read fresh each time so a replaced file is noticed; null when missing or empty. */
  const readSecret = (path: string): string | null => {
    try {
      return deps.files.read(path).trim() || null;
    } catch {
      return null;
    }
  };
  /** Claude's own GitHub token. */
  const readToken = (): string | null => readSecret(config.tokenFile);
  // The service's own GitHub calls run as Claude's account. With no token they refuse: under launchd
  // gh would otherwise use whichever account it is logged in as, often the owner's.
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
  /** The same for the backlog, kept apart since the answers' list forgets every item that has no answers waiting. */
  const backlogSaid = new Map<string, string>();
  const sayOnceAbout = (key: string, ref: string, line: string) => {
    if (backlogSaid.get(key) === line) return;
    backlogSaid.set(key, line);
    say(ref, line);
  };
  /** What a failed gh call says, without the command it ran. */
  const ghWhy = (e: unknown) => message(e).replace(/^gh [\s\S]*? failed: /, '');

  /** A failure as a log line says it: the board's own ⚠️ words, or what went wrong and while doing what. */
  const failure = (e: unknown, doing: string): string => (e instanceof BoardError ? `${e.message} (${doing})` : `couldn't ${doing}: ${message(e)}`);

  // Only in memory, and rebuilt from the board and the process list after a restart.
  /** The items whose sessions were running at the last look; null before the first. */
  let previous: Set<string> | null = null;
  /** Whether the board's list of this service's claims has been read once since it started. */
  let checkedAtStartup = false;
  /** Sessions it has asked to stop for running too long, by process: when it asked, or 'forced' once it forced them. */
  const stopping = new Map<number, number | 'forced'>();
  /** In a dry run, the items it has said it would hand back, so that isn't said every minute. */
  const wouldHandBack = new Set<string>();
  let planned = 0;

  const logHint = (ref: Ref) => `Its output is the newest ${ref.owner}-${ref.repo}-${ref.n}-*.log in ${config.logDir}; the service's own log says why it stopped (grep it for ${refString(ref)}).`;

  /** Whether a session of this service is running for the record, under its PR or its issue. */
  const runningFor = (record: WorkRecord, live: Map<string, Running>): boolean =>
    [record.pr, record.issue].some((n) => n !== null && live.has(itemKey(record.repo, n)));

  /**
   * The board lists the answers this service claimed while the record is still at the version it had
   * when they were claimed, so a claim listed here with no session running is one whose session ended
   * without writing a new status (or never started). Each goes back to the owner, with where the
   * session's output is. Returns the items handed back. A session that wrote a new status moved the
   * version on, so its claim isn't listed and nothing is done.
   */
  async function giveUpOrphans(live: Map<string, Running>): Promise<{ claims: Found[]; handedBack: string[] }> {
    const claims = await boardCall<Found[]>(deps.board, 'GET', '/api/service-claims');
    const handedBack: string[] = [];
    for (const c of claims) {
      if (runningFor(c.record, live)) continue;
      const ref = refOf(c.record);
      const name = ref ? refString(ref) : `${c.record.repo} (record ${c.record.id})`;
      const hint = ref ? logHint(ref) : `The service's own log says why it stopped (grep it for ${c.record.repo}).`;
      if (dryRun) {
        if (!wouldHandBack.has(name)) say(name, `its session is no longer running and no new status was written; would hand the item back to ${OWNER_NAME} with the ask "${GAVE_UP_ASK}".`);
        wouldHandBack.add(name);
        handedBack.push(name);
        continue;
      }
      try {
        await boardCall(deps.board, 'POST', '/api/gave-up', { answerIds: c.answers.map((a) => a.id), hint });
      } catch (e) {
        // Still listed at the next look, so it is tried again then.
        warn(name, `${failure(e, `hand the item back to ${OWNER_NAME}`)}; will try again at the next look.`);
        continue;
      }
      handedBack.push(name);
      warn(name, `the session ended without writing a new status. Handed the item back to ${OWNER_NAME} on the board, with the ask "${GAVE_UP_ASK}"; this service won't take those answers again. ${hint}`);
    }
    return { claims, handedBack };
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

  /**
   * The environment a session in this repo runs in: Claude's own GitHub token, and its Claude token when the
   * config names one. Null, with a line saying why, when the repo isn't marked or a token is missing.
   */
  async function sessionEnv(repo: RepoConfig, name: string): Promise<NodeJS.ProcessEnv | null> {
    const unmarked = await markProblem(repo);
    if (unmarked) {
      warn(name, `not starting a session: ${unmarked}`);
      return null;
    }
    const token = readToken();
    if (!token) {
      warn(name, `not starting a session: ${config.tokenFile} is missing or empty, so the session couldn't act as Claude's own GitHub account.`);
      return null;
    }
    const claudeToken = config.claudeTokenFile === null ? null : readSecret(config.claudeTokenFile);
    if (config.claudeTokenFile !== null && !claudeToken) {
      warn(name, `not starting a session: ${config.claudeTokenFile} is missing or empty, so the session couldn't sign in to Claude.`);
      return null;
    }
    return { ...deps.env, GH_TOKEN: token, ...(claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}) };
  }

  const logPathFor = (base: string) => join(config.logDir, `${base}-${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}.log`);

  /**
   * Finds the worktree and writes the prompt, all before anything is claimed, so an answer this
   * service can't serve stays free for others. Then claims the answers on the board, which in the
   * same step sets the ask to say a Mac session is working on them, and starts the session. If the
   * session can't start, the claim is given back.
   */
  async function startSession(repo: RepoConfig, ref: Ref, waiting: Found): Promise<void> {
    const name = refString(ref);
    const isPr = waiting.record.pr !== null;
    const env = await sessionEnv(repo, name);
    if (!env) return;
    const branch = isPr ? await prBranch(ref) : `issue-${ref.n}`;
    const cwd = await worktreeFor(repo, ref, isPr, branch);
    const logPath = logPathFor(`${ref.owner}-${ref.repo}-${ref.n}`);
    if (dryRun) {
      planned++;
      const prompt = promptFor(ref, cwd, describe(waiting.record, waiting.answers));
      say(name, `would claim and start: ${config.claude} --name "${sessionName(ref)}" -p <the prompt below> ${config.claudeArgs.join(' ')}\n  in ${cwd}\n  with GH_TOKEN from ${config.tokenFile}${config.claudeTokenFile ? ` and CLAUDE_CODE_OAUTH_TOKEN from ${config.claudeTokenFile}` : ''}\n  output to ${logPath}\n  prompt:\n${indent(prompt)}`);
      return;
    }
    deps.files.mkdir(config.logDir);

    // The last check before the claim: the session must not act as the owner's own GitHub account.
    await refuseOwner(gh, ownerAdvice);
    // If the board takes the claim but its reply is lost, no session starts; the next look finds the
    // claim with no session running and hands the item back.
    const claimed = await boardCall<Found>(deps.board, 'POST', '/api/claim', { ...where(ref), by: 'service' });
    if (claimed.answers.length === 0) {
      say(name, 'another session claimed its answers first; leaving them to that one.');
      return;
    }
    const answerIds = claimed.answers.map((a) => a.id);

    // The claim may hold answers that came in since the list was read, so the prompt is written from what was claimed.
    const prompt = promptFor(ref, cwd, describe(claimed.record, claimed.answers));
    const started = await launch(name, sessionName(ref), prompt, cwd, env, logPath, () => boardCall(deps.board, 'POST', '/api/unclaim', { answerIds }));
    // Counted as running from now, so its end is noticed even if that is before the next look.
    if (started) previous?.add(name);
  }

  /** Starts sessions for the answers the board says nobody claimed within the grace period. Returns how many items had some. */
  async function serveWaiting(live: Map<string, Running>): Promise<number> {
    const waiting = await boardCall<Found[]>(deps.board, 'POST', '/api/unclaimed', { olderThanMs: config.graceMs });
    let ripe = 0;
    const seen = new Set<string>();
    for (const w of waiting) {
      const ref = refOf(w.record);
      if (!ref) {
        err(`The board has answers for ${w.record.repo}, which isn't a repo name it can read; leaving them alone.`);
        continue;
      }
      const name = refString(ref);
      seen.add(name);
      const repo = repos.find((r) => r.owner === ref.owner && r.repo === ref.repo);
      if (!repo) {
        sayOnce(name, `has answers nobody picked up, but ${w.record.repo} is not one of the repos this service serves; leaving them for a session.`);
        continue;
      }
      // A session of its own may still be running after writing a new status; the next one waits for it.
      if (runningFor(w.record, live)) {
        sayOnce(name, 'has new answers, but its session from before is still running; it waits for that one to finish.');
        continue;
      }
      ripe++;
      if (!slotFree(live)) {
        sayOnce(name, `has answers nobody picked up, but ${config.maxSessions} ${config.maxSessions === 1 ? 'session is' : 'sessions are'} already running; it waits for one to finish.`);
        continue;
      }
      lastSaid.delete(name);
      try {
        await startSession(repo, ref, w);
      } catch (e) {
        warn(name, failure(e, 'start a session'));
      }
    }
    // An item no longer waiting is said afresh if it comes back.
    for (const name of [...lastSaid.keys()]) if (!seen.has(name)) lastSaid.delete(name);
    return ripe;
  }

  // ---------------------------------------------------------------------------
  // The backlog: proposals, the owner's answers to them, and picked-up issues.
  // ---------------------------------------------------------------------------

  const repoConfig = (name: string): RepoConfig | undefined => repos.find((r) => `${r.owner}/${r.repo}` === name);
  const refIn = (repo: string, n: number): Ref => {
    const [owner = '', name = ''] = repo.split('/');
    return { owner, repo: name, n };
  };
  const slotFree = (live: Map<string, Running>) => live.size + planned < config.maxSessions;
  const backlogLogHint = (repo: string) => `Its output is the newest ${repo.replace('/', '-')}-backlog-*.log in ${config.logDir}.`;

  /**
   * The detached checkout of the default branch that proposal and note sessions read in, at
   * <clone>/.claude/worktrees/backlog. Brought up to date each time; they make no commits there.
   */
  async function backlogWorktree(repo: RepoConfig): Promise<string> {
    const path = join(repo.clone, '.claude', 'worktrees', 'backlog');
    const name = `${repo.owner}/${repo.repo}`;
    if (dryRun) {
      say(name, `would bring ${path} up to date with the default branch.`);
      return path;
    }
    const base = (await gh(['api', `repos/${name}`, '-q', '.default_branch'])).trim();
    await deps.git(['-C', repo.clone, 'fetch', '--', 'origin', base]);
    if (deps.files.isDirectory(path)) await deps.git(['-C', path, 'checkout', '--detach', `origin/${base}`]);
    else await deps.git(['-C', repo.clone, 'worktree', 'add', '--detach', '--', path, `origin/${base}`]);
    return path;
  }

  /**
   * Starts a session that has been claimed on the board. If it can't start, `giveBack` returns the claim, so the
   * next look tries again. Returns whether it started.
   */
  async function launch(name: string, sessionLabel: string, prompt: string, cwd: string, env: NodeJS.ProcessEnv, logPath: string, giveBack: () => Promise<unknown>): Promise<boolean> {
    let session: Session;
    try {
      // The name comes first, so the process list shows it before the long prompt.
      session = deps.spawn(config.claude, ['--name', sessionLabel, '-p', prompt, ...config.claudeArgs], { cwd, env, logPath });
      await session.spawned;
    } catch (e) {
      const why = `Couldn't start a session (${message(e)}).`;
      try {
        await giveBack();
        warn(name, `${why} Gave it back on the board, so the next look tries again.`);
      } catch (u) {
        warn(name, `${why} And couldn't give it back on the board: ${message(u)} The next look hands it back to ${OWNER_NAME}.`);
      }
      return false;
    }
    planned++;
    say(name, `started a session (process ${session.pid ?? 'unknown'}) in ${cwd}; its output goes to ${logPath}.`);
    void session.exited.then((code) => say(name, `the session finished (exit code ${code ?? 'unknown'}).`));
    return true;
  }

  /** Something on the backlog went wrong: it goes back to the owner with what it was. */
  async function backlogFailed(name: string, path: '/api/proposal-failed' | '/api/pickup-failed', id: number, failure: string): Promise<void> {
    if (dryRun) {
      sayOnceAbout(`${name} failed`, name, `would hand it back to ${OWNER_NAME}: ${failure}`);
      return;
    }
    try {
      await boardCall(deps.board, 'POST', path, { id, failure });
      warn(name, `handed back to ${OWNER_NAME}: ${failure}`);
    } catch (e) {
      warn(name, `${failure} And couldn't say so on the board (${message(e)}); will try again at the next look.`);
    }
  }

  /** Sessions that ended without doing what they were started for go back to the owner. */
  async function backlogOrphans(proposals: Proposal[], pickups: Pickup[], live: Map<string, Running>): Promise<void> {
    for (const p of proposals.filter(isUnderWay)) {
      if (!repoConfig(p.repo)) continue;
      const running = live.has(backlogKey(p.repo));
      if (p.startedAt !== null && p.writtenAt === null && !running) {
        await backlogFailed(p.repo, '/api/proposal-failed', p.id, `The session that looks through the backlog ended without writing a list. ${backlogLogHint(p.repo)}`);
      } else if (p.noteStartedAt !== null && !running) {
        await backlogFailed(p.repo, '/api/proposal-failed', p.id, `The session for your note ended without saying it was done. ${backlogLogHint(p.repo)}`);
      } else if (p.carriedAt !== null && p.carryDoneAt === null) {
        // Answers are carried out within one look, so taken answers not done by the next look were cut short.
        await backlogFailed(p.repo, '/api/proposal-failed', p.id, 'The Mac service stopped while carrying out your answers; some may not be done. Check the issues on GitHub.');
      }
    }
    for (const u of pickups) {
      if (!repoConfig(u.repo) || u.startedAt === null || u.failedAt !== null || u.droppedAt !== null || live.has(itemKey(u.repo, u.issue))) continue;
      const ref = refIn(u.repo, u.issue);
      await backlogFailed(refString(ref), '/api/pickup-failed', u.id, `The session ended without writing a first status. ${logHint(ref)}`);
    }
  }

  /** Carries out the owner's answers to a proposal: labels and pick-ups, and closes. Needs no session. */
  async function carryOut(p: Proposal): Promise<void> {
    const items = (p.items ?? []).filter(isAsked);
    if (dryRun) {
      sayOnceAbout(`${p.repo} carry`, p.repo, `would carry out the answers: ${items.map((i) => `#${i.issue} ${p.answers?.[String(i.issue)]}`).join(', ') || 'nothing to do'}${p.note ? ', then start a session for the note' : ''}.`);
      return;
    }
    try {
      await boardCall(deps.board, 'POST', '/api/proposal-carry', { id: p.id });
    } catch (e) {
      if (e instanceof Refused) return;
      throw e;
    }
    const problems: string[] = [];
    const done: string[] = [];
    for (const item of items) {
      const choice = p.answers?.[String(item.issue)];
      const ref = refIn(p.repo, item.issue);
      try {
        if (choice === PICK_UP) {
          await pickUp(gh, deps.board, ref, p.id);
          done.push(`picked up #${item.issue}`);
        } else if (choice === CLOSE) {
          await gh(['issue', 'close', String(item.issue), '-R', p.repo, '--comment', closeComment(item.reason)]);
          done.push(`closed #${item.issue}`);
        }
      } catch (e) {
        problems.push(`Couldn't ${choice} #${item.issue}: ${ghWhy(e)}`);
      }
    }
    say(p.repo, `carried out the answers to the proposal: ${done.join(', ') || 'nothing to do'}.`);
    if (problems.length > 0) {
      await backlogFailed(p.repo, '/api/proposal-failed', p.id, `${problems.join(' ')}${p.note ? ' Your note was not acted on.' : ''}`);
    } else if (p.note) {
      await boardCall(deps.board, 'POST', '/api/proposal-carry-done', { id: p.id });
    } else {
      await boardCall(deps.board, 'POST', '/api/proposal-done', { id: p.id });
    }
  }

  async function startNoteSession(repo: RepoConfig, p: Proposal): Promise<void> {
    const env = await sessionEnv(repo, p.repo);
    if (!env) return;
    const cwd = await backlogWorktree(repo);
    const logPath = logPathFor(`${p.repo.replace('/', '-')}-backlog`);
    if (dryRun) {
      planned++;
      say(p.repo, `would start a session for the note to the proposal, in ${cwd}, output to ${logPath}; prompt:\n${indent(notePrompt(p, cwd))}`);
      return;
    }
    deps.files.mkdir(config.logDir);
    await refuseOwner(gh, ownerAdvice);
    const { proposal } = await boardCall<{ proposal: Proposal }>(deps.board, 'POST', '/api/proposal-note-started', { id: p.id });
    await launch(p.repo, backlogKey(p.repo), notePrompt(proposal, cwd), cwd, env, logPath, () => boardCall(deps.board, 'POST', '/api/proposal-note-unstarted', { id: p.id }));
  }

  async function startProposalSession(repo: RepoConfig, p: Proposal): Promise<void> {
    const env = await sessionEnv(repo, p.repo);
    if (!env) return;
    const cwd = await backlogWorktree(repo);
    const logPath = logPathFor(`${p.repo.replace('/', '-')}-backlog`);
    if (dryRun) {
      planned++;
      say(p.repo, `would claim the proposal and start a session to read the backlog, in ${cwd}, output to ${logPath}.`);
      return;
    }
    deps.files.mkdir(config.logDir);
    await refuseOwner(gh, ownerAdvice);
    const { skip } = await boardCall<{ proposal: Proposal; skip: Skip[] }>(deps.board, 'POST', '/api/proposal-claim', { id: p.id });
    await launch(p.repo, backlogKey(p.repo), proposalPrompt(p.repo, cwd, skip), cwd, env, logPath, () => boardCall(deps.board, 'POST', '/api/proposal-unclaim', { id: p.id }));
  }

  async function startPickupSession(repo: RepoConfig, u: Pickup, reason: string | null): Promise<void> {
    const ref = refIn(u.repo, u.issue);
    const name = refString(ref);
    const env = await sessionEnv(repo, name);
    if (!env) return;
    const cwd = await worktreeFor(repo, ref, false, `issue-${u.issue}`);
    const logPath = logPathFor(`${ref.owner}-${ref.repo}-${ref.n}`);
    const prompt = pickupPrompt(u.repo, u.issue, cwd, reason);
    if (dryRun) {
      planned++;
      say(name, `would claim the pick-up and start a session in ${cwd}, output to ${logPath}; prompt:\n${indent(prompt)}`);
      return;
    }
    deps.files.mkdir(config.logDir);
    await refuseOwner(gh, ownerAdvice);
    await boardCall(deps.board, 'POST', '/api/pickup-claim', { id: u.id });
    await launch(name, pickupSessionName(u.repo, u.issue), prompt, cwd, env, logPath, () => boardCall(deps.board, 'POST', '/api/pickup-unclaim', { id: u.id }));
  }

  /**
   * One look at the backlog: hands back what ended badly, takes labels off dropped pick-ups, carries out answers,
   * and then, while sessions are free, starts the sessions for notes, for proposals and for pick-ups, in that order.
   * Answers to work already had their turn at the free sessions.
   */
  async function serveBacklog(live: Map<string, Running>): Promise<void> {
    const { proposals, pickups } = await boardCall<{ proposals: Proposal[]; pickups: Pickup[] }>(deps.board, 'GET', '/api/backlog-work');
    await backlogOrphans(proposals, pickups, live);
    const served = (repo: string) => repoConfig(repo) !== undefined;

    for (const u of pickups.filter((x) => x.droppedAt !== null && served(x.repo))) {
      const ref = refIn(u.repo, u.issue);
      if (dryRun) {
        sayOnceAbout(`${refString(ref)} drop`, refString(ref), `would take the ${LABEL_IN_PROGRESS} label off; it was dropped.`);
        continue;
      }
      try {
        await gh(['issue', 'edit', String(u.issue), '-R', u.repo, '--remove-label', LABEL_IN_PROGRESS]);
        await boardCall(deps.board, 'POST', '/api/pickup-done', { id: u.id });
        say(refString(ref), `dropped: took the ${LABEL_IN_PROGRESS} label off.`);
      } catch (e) {
        warn(refString(ref), `${failure(e, `take the ${LABEL_IN_PROGRESS} label off`)}; will try again at the next look.`);
      }
    }

    for (const p of proposals.filter((x) => isUnderWay(x) && x.answeredAt !== null && x.carriedAt === null && served(x.repo))) {
      try {
        await carryOut(p);
      } catch (e) {
        warn(p.repo, failure(e, 'carry out the answers to the proposal'));
      }
    }
    // Carrying out may have finished or failed some, so the sessions are chosen from a fresh list.
    const fresh = dryRun ? { proposals, pickups } : await boardCall<{ proposals: Proposal[]; pickups: Pickup[] }>(deps.board, 'GET', '/api/backlog-work');

    type Start = { what: string; go: () => Promise<void> };
    const starts: Start[] = [];
    for (const p of fresh.proposals.filter((x) => isUnderWay(x) && x.carryDoneAt !== null && (x.note ?? '') !== '' && x.noteStartedAt === null)) {
      const repo = repoConfig(p.repo);
      if (repo && !live.has(backlogKey(p.repo))) starts.push({ what: `${p.repo}: a session for the note`, go: () => startNoteSession(repo, p) });
    }
    for (const p of fresh.proposals.filter((x) => isUnderWay(x) && x.startedAt === null)) {
      const repo = repoConfig(p.repo);
      if (repo && !live.has(backlogKey(p.repo))) starts.push({ what: `${p.repo}: a session to read the backlog`, go: () => startProposalSession(repo, p) });
    }
    for (const u of fresh.pickups.filter((x) => x.startedAt === null && x.failedAt === null && x.droppedAt === null)) {
      const repo = repoConfig(u.repo);
      const reason = pickupReason(u, fresh.proposals);
      if (repo && !live.has(itemKey(u.repo, u.issue))) starts.push({ what: `${itemKey(u.repo, u.issue)}: a session for the pick-up`, go: () => startPickupSession(repo, u, reason) });
    }
    const waiting: string[] = [];
    for (const s of starts) {
      if (!slotFree(live)) {
        waiting.push(s.what);
        continue;
      }
      try {
        await s.go();
      } catch (e) {
        warn(s.what.split(':')[0]!, failure(e, 'start a session'));
      }
    }
    if (waiting.length > 0) sayOnceAbout('backlog', 'backlog', `${config.maxSessions} sessions are running; waiting for one to finish before starting ${waiting.join('; ')}.`);
    else backlogSaid.delete('backlog');
  }

  /** Tells the board how many sessions are running and which repos this service serves, for the page's Backlog. */
  async function reportLook(live: Map<string, Running>): Promise<void> {
    if (dryRun) return;
    await boardCall(deps.board, 'POST', '/api/service-look', { running: live.size + planned, max: config.maxSessions, repos: repos.map((r) => `${r.owner}/${r.repo}`) });
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

  /** A failure of a whole look as a log line: the board's own ⚠️ words first, or what went wrong. */
  const lookFailure = (e: unknown, doing: string): string => (e instanceof BoardError ? e.message : `Couldn't ${doing} (${message(e)}).`);

  out(`${dryRun ? 'Dry run: claims nothing, creates nothing, starts nothing, writes nothing to the board. ' : ''}Looking every ${config.pollMs / 1000} s on the board for answers to ${repos.map((r) => `${r.owner}/${r.repo}`).join(', ')} unclaimed after ${config.graceMs / MIN} min; at most ${config.maxSessions} sessions at once.`);
  let failures = 0;
  for (;;) {
    planned = 0;
    let failed = false;
    let ripe = 0;
    let live: Map<string, Running> | null = null;
    try {
      live = runningSessions(await deps.ps(['-axww', '-o', 'pid=,etime=,args=']), config.claude);
    } catch (e) {
      failed = true;
      err(`Couldn't list the running processes (${message(e)}), so it can't tell which sessions are running; starting none this time.`);
    }
    if (live) {
      if (previous === null && live.size > 0) out(`Found ${live.size} ${live.size === 1 ? 'session' : 'sessions'} of its own still running: ${[...live.keys()].join(', ')}.`);
      try {
        const { claims, handedBack } = await giveUpOrphans(live);
        if (!checkedAtStartup) {
          checkedAtStartup = true;
          if (claims.length > 0) {
            out(`At startup, ${claims.length} ${claims.length === 1 ? 'item had answers' : 'items had answers'} claimed by its sessions; ${handedBack.length === 0 ? 'every one still has its session running' : `${handedBack.length} had no session still running and ${dryRun ? 'would go' : 'went'} back to ${OWNER_NAME}: ${handedBack.join(', ')}`}.`);
          }
        }
        // A session seen running last time whose claim is no longer listed ended after a new status moved the version on.
        const claimed = new Set(claims.flatMap((c) => [c.record.pr, c.record.issue].filter((n) => n !== null).map((n) => itemKey(c.record.repo, n))));
        for (const name of previous ?? []) {
          // A backlog session's end is dealt with by the look at the backlog.
          if (name.endsWith(' backlog')) continue;
          if (!live.has(name) && !claimed.has(name)) say(name, 'the session ended after a new status was written, or the item closed; nothing to do.');
        }
      } catch (e) {
        failed = true;
        err(lookFailure(e, "read the board's list of answers its sessions claimed"));
      }
      previous = new Set(live.keys());
      stopLongRunning(live);
      try {
        ripe = await serveWaiting(live);
      } catch (e) {
        failed = true;
        err(lookFailure(e, 'ask the board for answers nobody claimed'));
      }
      try {
        await serveBacklog(live);
      } catch (e) {
        failed = true;
        err(lookFailure(e, "read the board's backlog"));
      }
      try {
        await reportLook(live);
      } catch (e) {
        // The page then says the service's look is out of date; nothing else depends on it.
        err(lookFailure(e, 'tell the board how many sessions are running'));
      }
    }
    if (once) {
      if (ripe === 0 && !failed) out(`No answers waiting past the ${config.graceMs / MIN} min grace period; nothing to do.`);
      return failed ? 1 : 0;
    }
    // Back off when the board or the process list couldn't be read; one item failing alone doesn't.
    failures = failed ? failures + 1 : 0;
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
    board: realBoardDeps(),
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
