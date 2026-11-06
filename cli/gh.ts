import { execFile } from 'node:child_process';

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
