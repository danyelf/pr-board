// One-off clean-up for the switch to the board: removes the status sections the earlier design wrote
// on GitHub. Run it as Claude's account, once, after the board holds every open item's record:
//   node cli/remove-old-status.ts [--dry-run] owner/repo [owner/repo ...]
// On each open PR it removes the status section from the description. On each open issue it deletes
// the comments that this account wrote and that begin with a status section; anyone else's are left.
import { flattenPages, gh, refuseOwner } from './gh.ts';
import type { Deps } from './gh.ts';

// The markers the earlier design wrapped its status section in. Nothing else writes them any more.
const STATUS_OPEN = '<!-- status -->';
const STATUS_CLOSE = '<!-- /status -->';

interface Item { number: number; body?: string | null; pull_request?: unknown }
interface Comment { id: number; body?: string | null; user?: { login?: string } | null }

/** The text with every status section taken out, or null when it has none. */
export function withoutStatus(text: string): string | null {
  let result = text;
  let changed = false;
  for (;;) {
    const start = result.indexOf(STATUS_OPEN);
    if (start === -1) break;
    const close = result.indexOf(STATUS_CLOSE, start + STATUS_OPEN.length);
    if (close === -1) break;
    const before = result.slice(0, start).trimEnd();
    const after = result.slice(close + STATUS_CLOSE.length).trimStart();
    result = before && after ? `${before}\n\n${after}` : before || after;
    changed = true;
  }
  return changed ? result : null;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const dryRun = argv.includes('--dry-run');
  const repos = argv.filter((a) => a !== '--dry-run');
  if (repos.length === 0 || repos.some((r) => !/^[^/\s]+\/[^/\s]+$/.test(r))) {
    err('Usage: remove-old-status [--dry-run] <owner/repo> [<owner/repo> ...]');
    return 1;
  }

  let me: string;
  try {
    me = await refuseOwner(deps.gh, 'Run this as Claude\'s account, which wrote the status comments it deletes.');
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }

  let failed = false;
  for (const repo of repos) {
    try {
      const items = flattenPages(await deps.gh(['api', `repos/${repo}/issues?state=open&per_page=100`, '--paginate', '--slurp'])) as Item[];
      for (const item of items) {
        const name = `${repo}#${item.number}`;
        try {
          if (item.pull_request) {
            const body = withoutStatus(item.body ?? '');
            if (body === null) continue;
            if (dryRun) {
              out(`${name}: would remove the status section from the description`);
            } else {
              await deps.gh(['api', '-X', 'PATCH', `repos/${repo}/pulls/${item.number}`, '-f', `body=${body}`]);
              out(`${name}: removed the status section from the description`);
            }
            continue;
          }
          const comments = flattenPages(await deps.gh(['api', `repos/${repo}/issues/${item.number}/comments?per_page=100`, '--paginate', '--slurp'])) as Comment[];
          for (const c of comments) {
            if (!(c.body ?? '').trimStart().startsWith(STATUS_OPEN)) continue;
            const author = c.user?.login ?? 'someone unknown';
            if (author !== me) {
              out(`${name}: left status comment ${c.id} alone, since ${author} wrote it`);
            } else if (dryRun) {
              out(`${name}: would delete status comment ${c.id}`);
            } else {
              await deps.gh(['api', '-X', 'DELETE', `repos/${repo}/issues/comments/${c.id}`]);
              out(`${name}: deleted status comment ${c.id}`);
            }
          }
        } catch (e) {
          failed = true;
          err(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      failed = true;
      err(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), { gh });
}
