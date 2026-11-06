import { execFile } from 'node:child_process';

export type Gh = (args: string[], opts?: { cwd?: string }) => Promise<string>;

export interface Deps {
  gh: Gh;
  now: () => Date;
  home: string;
  /** Where normal output goes; defaults to stdout. */
  out?: (line: string) => void;
  /** Where complaints go; defaults to stderr. */
  err?: (line: string) => void;
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
