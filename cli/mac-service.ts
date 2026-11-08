// The always-on service on the Mac. Once a minute it looks, in each repo it is set up for, for the
// owner's answers from the board that no Claude session has claimed within a grace period, claims
// them with a 👀 reaction and starts a fresh Claude session for them in the item's worktree.
//   node cli/mac-service.ts [--config <file>] [--dry-run] [--once]
// The config file is --config, else $PR_BOARD_SERVICE_CONFIG, else ~/.pr-board/service.json.
// It never stops on its own because of errors; it stops on SIGTERM or SIGINT and leaves the
// sessions it started running.
import { spawn as spawnChild } from 'node:child_process';
import { accessSync, appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { OWNER_LOGIN, OWNER_NAME } from '../src/shared/config.ts';
import { LABEL_ON_OWNER, PICKUP_GRACE_MS } from '../src/shared/names.ts';
import { flattenPages, gh as realGh, git as realGit, refString } from './gh.ts';
import type { Gh, Ref } from './gh.ts';
import { claim, describe, waitingAnswers, type Found } from './watch-answers.ts';

const MIN = 60_000;
const MAX_BACKOFF_MS = 5 * MIN;
const USAGE = 'Usage: mac-service [--config <file>] [--dry-run] [--once]';

export interface RepoConfig { owner: string; repo: string; clone: string }

export interface Config {
  repos: RepoConfig[];
  /** How long an answer may wait for an open session before this service starts one. */
  graceMs: number;
  /** The most sessions it has running at once. */
  maxSessions: number;
  pollMs: number;
  /** Where each session's output goes, one file per session. */
  logDir: string;
  /** The file holding the GitHub token of Claude's own account. */
  tokenFile: string;
  /** The claude program itself (not a shell function wrapping it). */
  claude: string;
  /** Flags added after the prompt and the name, such as --permission-mode. */
  claudeArgs: string[];
}

export interface SpawnOptions { cwd: string; env: NodeJS.ProcessEnv; logPath: string }

/** A session started in the background: its process id and when it ends (with its exit code, or null). */
export interface Session { pid: number | undefined; exited: Promise<number | null> }

export interface ServiceDeps {
  gh: Gh;
  git: Gh;
  files: {
    /** Throws when the file can't be read. */
    read: (path: string) => string;
    isDirectory: (path: string) => boolean;
    isExecutable: (path: string) => boolean;
    mkdir: (path: string) => void;
  };
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SETTINGS = ['repos', 'graceMinutes', 'maxSessions', 'pollSeconds', 'logDir', 'tokenFile', 'claude', 'claudeArgs'];

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
    graceMs: num('graceMinutes', 5, (n) => n >= 0, 'a number of minutes, 0 or more') * MIN,
    maxSessions: num('maxSessions', 2, (n) => Number.isInteger(n) && n >= 1, 'a whole number, 1 or more'),
    pollMs: num('pollSeconds', 60, (n) => n >= 1, 'a number of seconds, 1 or more') * 1000,
    logDir: d.logDir === undefined ? join(home, '.pr-board', 'logs') : absolute(d.logDir, 'logDir'),
    tokenFile: d.tokenFile === undefined ? join(home, '.config', 'claude-github', 'token') : absolute(d.tokenFile, 'tokenFile'),
    claude: d.claude === undefined ? join(home, '.local', 'bin', 'claude') : absolute(d.claude, 'claude'),
    claudeArgs: claudeArgs as string[],
  };
}

/** The worktree checked out on `branch`, from `git worktree list --porcelain`, or null. */
function worktreeOn(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (lines.includes(`branch refs/heads/${branch}`)) return lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length) ?? null;
  }
  return null;
}

/** What the fresh session is told: the answers, as the watcher prints them, and how to act on them. */
function promptFor(ref: Ref, isPr: boolean, described: string[]): string {
  const kind = isPr ? 'PR' : 'issue';
  return [
    `These are ${OWNER_NAME}'s answers from PR Board to ${refString(ref)}. No open Claude session picked them up, so the PR Board service on the Mac started this fresh session for them, in this ${kind}'s worktree, and claimed them with a 👀 so no other session takes them.`,
    '',
    ...described.flatMap((d) => [d, '']),
    `This session has no chat memory of ${refString(ref)}. Before acting:`,
    `1) Read the ${kind} on GitHub and its status section (the pr-status skill's show command prints the status), and check this worktree's branch is up to date with GitHub.`,
    '2) Act on the answers as the pr-status skill says under "Answers from the board". If an answer\'s fingerprint does not match the current status, apply nothing from it and ask again.',
    `3) End by running pr-status set with the new state. Don't start the watcher: this session ends when you finish, and the service starts a new one for ${OWNER_NAME}'s next answers.`,
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
    for (const r of config.repos) {
      if (!deps.files.isDirectory(r.clone)) throw new Error(`${configPath}: ${r.clone}, the clone of ${r.owner}/${r.repo}, isn't a directory`);
    }
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
  // The service's own GitHub calls, the claim among them, run as Claude's account when its token is there.
  // Under launchd gh would otherwise use whichever account it is logged in as, often the owner's.
  const gh: Gh = (args, opts) => {
    const token = readToken();
    return deps.gh(args, { ...opts, env: token ? { ...deps.env, GH_TOKEN: token } : deps.env });
  };

  try {
    const me = (await gh(['api', 'user', '-q', '.login'])).trim();
    if (me === OWNER_LOGIN) {
      err(`gh is signed in as ${me}, the board's owner, and ${config.tokenFile} has no token to use instead. The board doesn't count the owner's own 👀 as a claim. Put Claude's own token in that file.`);
      return 1;
    }
  } catch (e) {
    err(`Couldn't tell which account gh is signed in as (${message(e)}); going on anyway.`);
  }

  const running = new Map<string, Session>();
  let planned = 0;

  async function worktreeFor(repo: RepoConfig, ref: Ref, isPr: boolean, branch: string): Promise<string> {
    const found = worktreeOn(await deps.git(['-C', repo.clone, 'worktree', 'list', '--porcelain']), branch);
    if (found) return found;
    const path = join(repo.clone, '.claude', 'worktrees', branch);
    if (dryRun) {
      out(`Would create the worktree ${path} on ${isPr ? `the PR's branch ${branch}` : `a new branch ${branch} from the default branch`}.`);
      return path;
    }
    const hasLocal = await deps.git(['-C', repo.clone, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    if (isPr) {
      await deps.git(['-C', repo.clone, 'fetch', 'origin', branch]);
      await deps.git(hasLocal
        ? ['-C', repo.clone, 'worktree', 'add', path, branch]
        : ['-C', repo.clone, 'worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
    } else {
      const base = (await gh(['api', `repos/${ref.owner}/${ref.repo}`, '-q', '.default_branch'])).trim();
      await deps.git(['-C', repo.clone, 'fetch', 'origin', base]);
      await deps.git(hasLocal
        ? ['-C', repo.clone, 'worktree', 'add', path, branch]
        : ['-C', repo.clone, 'worktree', 'add', '-b', branch, path, `origin/${base}`]);
    }
    out(`Created the worktree ${path} for ${refString(ref)}.`);
    return path;
  }

  /** Checks it may act as Claude here, finds the worktree, claims the answers and starts the session. */
  async function startSession(repo: RepoConfig, ref: Ref, isPr: boolean, answers: Found[]): Promise<void> {
    const name = refString(ref);
    // These checks come before the claim, so an answer this service can't serve stays free for others.
    const marked = await deps.git(['-C', repo.clone, 'config', '--local', '--get', 'claude.bot']).then((s) => s.trim(), () => '');
    if (marked !== 'true') {
      err(`Not starting a session for ${name}: ${repo.clone} is not marked claude.bot=true, so the session would act as ${OWNER_NAME}'s own GitHub account. To let Claude act there under its own account: git -C ${repo.clone} config claude.bot true`);
      return;
    }
    const token = readToken();
    if (!token) {
      err(`Not starting a session for ${name}: ${config.tokenFile} is missing or empty, so the session couldn't act as Claude's own GitHub account.`);
      return;
    }
    const branch = isPr ? (await gh(['api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.n}`, '-q', '.head.ref'])).trim() : `issue-${ref.n}`;
    const cwd = await worktreeFor(repo, ref, isPr, branch);

    let mine = answers;
    if (!dryRun) {
      mine = [];
      for (const f of answers) {
        try {
          if (await claim(gh, f)) mine.push(f);
          else out(`${f.url} was already claimed by another session; leaving it to that one.`);
        } catch (e) {
          err(`Couldn't claim ${f.url}: ${message(e)}`);
        }
      }
      if (mine.length === 0) return;
    }

    const described: string[] = [];
    for (const f of mine) described.push(await describe(gh, f));
    const prompt = promptFor(ref, isPr, described);
    const args = ['-p', prompt, '--name', `${ref.repo}#${ref.n} answers`, ...config.claudeArgs];
    const logPath = join(config.logDir, `${ref.owner}-${ref.repo}-${ref.n}-${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}.log`);
    if (dryRun) {
      planned++;
      out(`Would claim and start: ${config.claude} -p <the prompt below> ${args.slice(2).join(' ')}\n  in ${cwd}\n  with GH_TOKEN from ${config.tokenFile}\n  output to ${logPath}\n  prompt:\n${indent(prompt)}`);
      return;
    }
    let session: Session;
    try {
      deps.files.mkdir(config.logDir);
      session = deps.spawn(config.claude, args, { cwd, env: { ...deps.env, GH_TOKEN: token }, logPath });
    } catch (e) {
      err(`Claimed the answers on ${name} but couldn't start a session (${message(e)}). Nobody has them now: take this account's 👀 off ${mine.map((f) => f.url).join(', ')} so a session can pick them up.`);
      return;
    }
    running.set(name, session);
    out(`Started a session for ${name} (process ${session.pid ?? 'unknown'}) in ${cwd}; its output goes to ${logPath}.`);
    void session.exited.then((code) => {
      running.delete(name);
      out(`The session for ${name} finished (exit code ${code ?? 'unknown'}); its output is in ${logPath}.`);
    });
  }

  /** The owner's waiting answers in one repo. Returns how many items had some past their grace period. */
  async function serveRepo(repo: RepoConfig): Promise<number> {
    const label = encodeURIComponent(LABEL_ON_OWNER);
    const rows = flattenPages(await gh(['api', `repos/${repo.owner}/${repo.repo}/issues?labels=${label}&state=open&per_page=100`, '--paginate', '--slurp'])) as
      { number: number; comments?: number; pull_request?: unknown }[];
    let ripe = 0;
    if (once) {
      const read = rows.filter((r) => r.comments !== 0).length;
      out(`${repo.owner}/${repo.repo}: ${rows.length} open ${rows.length === 1 ? 'item carries' : 'items carry'} "${LABEL_ON_OWNER}"; ${read} with comments read for answers.`);
    }
    for (const row of rows) {
      // An item with no comments has no answers, so it isn't read any further.
      if (row.comments === 0) continue;
      const ref: Ref = { owner: repo.owner, repo: repo.repo, n: row.number };
      const name = refString(ref);
      if (running.has(name)) continue;
      const answers = await waitingAnswers(gh, [ref], out);
      if (!answers.some((f) => deps.now() - Date.parse(f.createdAt) >= config.graceMs)) continue;
      ripe++;
      if (running.size + planned >= config.maxSessions) {
        out(`${name} has answers nobody picked up, but ${config.maxSessions} ${config.maxSessions === 1 ? 'session is' : 'sessions are'} already running; it waits for one to finish.`);
        continue;
      }
      try {
        await startSession(repo, ref, Boolean(row.pull_request), answers);
      } catch (e) {
        err(`Couldn't start a session for ${name}: ${message(e)}`);
      }
    }
    return ripe;
  }

  out(`${dryRun ? 'Dry run: claims nothing, creates nothing, starts nothing. ' : ''}Looking every ${config.pollMs / 1000} s in ${config.repos.map((r) => `${r.owner}/${r.repo}`).join(', ')} for answers unclaimed after ${config.graceMs / MIN} min; at most ${config.maxSessions} sessions at once.`);
  let failures = 0;
  for (;;) {
    planned = 0;
    let failed = false;
    let ripe = 0;
    for (const repo of config.repos) {
      try {
        ripe += await serveRepo(repo);
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
    const wait = failures > 0 ? Math.min(config.pollMs * 2 ** failures, MAX_BACKOFF_MS) : config.pollMs;
    if (failures > 0) err(`Trying again in ${wait / 1000} s.`);
    if (deps.signal?.aborted) break;
    await deps.sleep(wait, deps.signal);
    if (deps.signal?.aborted) break;
  }
  out(`Stopping; leaving ${running.size} ${running.size === 1 ? 'session' : 'sessions'} running.`);
  return 0;
}

function spawnDetached(command: string, args: string[], opts: SpawnOptions): Session {
  const fd = openSync(opts.logPath, 'a');
  try {
    const child = spawnChild(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', (e) => {
        appendFileSync(opts.logPath, `\nCouldn't start ${command}: ${e.message}\n`);
        resolve(null);
      });
    });
    return { pid: child.pid, exited };
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
    },
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
