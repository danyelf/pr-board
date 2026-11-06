import { DAY_MS, LABEL_IN_PROGRESS, LABEL_ON_DANYEL, LABEL_PARKED, REPO_WINDOW_DAYS } from '../src/shared/names.ts';
import { flattenPages, gh } from './gh.ts';
import type { Deps as BaseDeps } from './gh.ts';

interface Deps extends BaseDeps {
  now: () => Date;
}

const LABELS = [
  { name: LABEL_ON_DANYEL, color: 'e8a33a', description: 'Waiting on Danyel: a look, an answer, or a merge' },
  { name: LABEL_PARKED, color: 'c9c6bd', description: 'Waiting on something outside Danyel and Claude' },
  { name: LABEL_IN_PROGRESS, color: '4a7bd0', description: 'Picked up: someone is working on it' },
];

interface RepoSummary { full_name: string; pushed_at: string | null }
interface RepoDetail { merge_commit_message?: string; squash_merge_commit_message?: string }

export async function main(argv: string[], deps: Deps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const dryRun = argv.includes('--dry-run');
  let failed = false;
  try {
    const cutoff = deps.now().getTime() - REPO_WINDOW_DAYS * DAY_MS;
    const repos = (flattenPages(await deps.gh(['api', 'user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100', '--paginate', '--slurp'])) as RepoSummary[])
      .filter((r) => r.pushed_at && Date.parse(r.pushed_at) >= cutoff);

    for (const repo of repos) {
      const name = repo.full_name;
      try {
        const existing = new Set((flattenPages(await deps.gh(['api', `repos/${name}/labels?per_page=100`, '--paginate', '--slurp'])) as { name: string }[]).map((l) => l.name));
        for (const label of LABELS) {
          if (existing.has(label.name)) {
            out(`${name}: "${label.name}" already exists`);
          } else if (dryRun) {
            out(`${name}: would create "${label.name}"`);
          } else {
            await deps.gh(['api', '-X', 'POST', `repos/${name}/labels`, '-f', `name=${label.name}`, '-f', `color=${label.color}`, '-f', `description=${label.description}`]);
            out(`${name}: created "${label.name}"`);
          }
        }
        const detail = JSON.parse(await deps.gh(['api', `repos/${name}`])) as RepoDetail;
        if (detail.merge_commit_message === 'PR_BODY' || detail.squash_merge_commit_message === 'PR_BODY') {
          out(`WARNING ${name}: merge commits copy the pull request description into history, so the status section would leak into commit messages. Change it in the repo's merge settings.`);
        }
      } catch (e) {
        failed = true;
        err(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (repos.length === 0) out(`No repos pushed to in the last ${REPO_WINDOW_DAYS} days.`);
    return failed ? 1 : 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), { gh, now: () => new Date() });
}
