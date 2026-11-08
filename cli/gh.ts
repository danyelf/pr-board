import { execFile } from 'node:child_process';
import { pickStatusComment } from '../src/shared/status.ts';

export type Gh = (args: string[], opts?: { cwd?: string }) => Promise<string>;

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
      execFile(command, args, { cwd: opts?.cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      });
    });
}

export const gh: Gh = run('gh');
export const git: Gh = run('git');

/** `gh api --paginate --slurp` returns an array of pages; flatten to one list. */
export function flattenPages(json: string): unknown[] {
  const parsed: unknown = JSON.parse(json || '[]');
  return Array.isArray(parsed) ? parsed.flat() : [];
}

export function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b|Not Found/i.test(message);
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

/** Every comment on the item, oldest first, however many pages there are. */
export async function issueComments<T extends { body: string }>(gh: Gh, ref: Ref): Promise<T[]> {
  const url = `repos/${ref.owner}/${ref.repo}/issues/${ref.n}/comments?per_page=100`;
  return flattenPages(await gh(['api', url, '--paginate', '--slurp'])) as T[];
}

export interface ItemRead<T> {
  isPr: boolean;
  /** Not closed, and for a PR not merged (a merged PR is closed too). */
  open: boolean;
  /** The text the status lives in. */
  statusText: string;
  /** For an issue, the comment that text comes from; null for a PR, or an issue with no status comment. */
  statusComment: T | null;
  comments: T[];
}

/**
 * An item and its comments, with the text its status lives in: a PR's description, or an issue's
 * last status comment. The same rule as `statusText` in src/shared/status.ts, read through `gh`.
 */
export async function readItem<T extends { body: string }>(gh: Gh, ref: Ref): Promise<ItemRead<T>> {
  const item = JSON.parse(await gh(['api', `repos/${ref.owner}/${ref.repo}/issues/${ref.n}`])) as {
    state?: string; pull_request?: unknown; body?: string | null;
  };
  const comments = await issueComments<T>(gh, ref);
  const isPr = Boolean(item.pull_request);
  const statusComment = isPr ? null : pickStatusComment(comments);
  return { isPr, open: item.state !== 'closed', statusText: isPr ? item.body ?? '' : statusComment?.body ?? '', statusComment, comments };
}

/** The text that holds an item's status, as the board reads it. */
export async function readStatusText(gh: Gh, ref: Ref): Promise<string> {
  return (await readItem(gh, ref)).statusText;
}
