import { execFile } from 'node:child_process';
import { OWNER_LOGIN } from '../src/shared/config.ts';

/** Runs a command. `env`, when given, replaces the environment it runs in. */
export type Gh = (args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string>;

export interface Deps {
  gh: Gh;
  /** Where normal output goes; defaults to stdout. */
  out?: (line: string) => void;
  /** Where complaints go; defaults to stderr. */
  err?: (line: string) => void;
}

/** A pull request or issue in a repo. */
export interface Ref { owner: string; repo: string; n: number }

export function refString(r: Ref): string {
  return `${r.owner}/${r.repo}#${r.n}`;
}

/** The repo that `cwd` (or the current directory) is a checkout of, according to `gh`. */
export async function currentRepo(gh: Gh, cwd?: string): Promise<{ owner: string; repo: string }> {
  const name = (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd })).trim();
  const [owner, repo] = name.split('/');
  if (!owner || !repo) throw new Error(`Couldn't tell which repo ${cwd ?? 'the current directory'} belongs to`);
  return { owner, repo };
}

function run(command: string): Gh {
  return (args, opts) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { cwd: opts?.cwd, env: opts?.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      });
    });
}

export const gh: Gh = run('gh');
export const git: Gh = run('git');
export const ps: Gh = run('ps');

/** Thrown when `gh` would act as the board's owner rather than as Claude's account. */
export class OwnerError extends Error {}

/**
 * Returns the login `gh` acts as. Throws an OwnerError when that is the board's owner: a session's
 * `gh` must be Claude's account, so that the review request asking the owner to look at a PR comes
 * from someone else and GitHub notifies them. Other failures (GitHub unreachable) are thrown as they
 * are, for the caller to decide on.
 */
export async function refuseOwner(gh: Gh, advice: string): Promise<string> {
  const login = (await gh(['api', 'user', '-q', '.login'])).trim();
  if (login === OWNER_LOGIN) throw new OwnerError(`gh is signed in as ${login}, the board's owner. Sessions must use Claude's account, so that the review request asking the owner to look comes from someone else and notifies them. ${advice}`);
  return login;
}

/** `gh api --paginate --slurp` returns an array of pages; flatten to one list. */
export function flattenPages(json: string): unknown[] {
  const parsed: unknown = JSON.parse(json || '[]');
  return Array.isArray(parsed) ? parsed.flat() : [];
}

/** Whether GitHub said 404. Reads only what the command printed, not the command, whose path may hold a 404 (item #404). */
export function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const at = message.lastIndexOf(' failed: ');
  return /\b404\b|Not Found/i.test(at === -1 ? message : message.slice(at + ' failed: '.length));
}

/** Reads "owner/repo#N", or "#N" (just the number, in the current directory's repo). Throws on anything else. */
export function readRef(text: string): Ref | { n: number } {
  const full = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(text);
  if (full) return { owner: full[1]!, repo: full[2]!, n: Number(full[3]) };
  const short = /^#(\d+)$/.exec(text);
  if (!short) throw new Error(`Can't read "${text}" as a reference; use owner/repo#N or #N`);
  return { n: Number(short[1]) };
}

/** The item a reference names; "#N" is looked up in the current directory's repo. */
export async function parseRef(text: string, gh: Gh): Promise<Ref> {
  const ref = readRef(text);
  return 'owner' in ref ? ref : { ...(await currentRepo(gh)), n: ref.n };
}
