import { OWNER_NAME } from '../src/shared/config.ts';
import {
  DAY_MS, LABEL_GATE_DESIGN, LABEL_GATE_IMPLEMENTATION, LABEL_GATE_PREP, LABEL_IN_PROGRESS, LABEL_ON_OWNER, LABEL_PARKED,
  LABEL_READY_TO_MERGE, REPO_WINDOW_DAYS,
} from '../src/shared/names.ts';
import { MANAGED_LABELS } from '../src/shared/labels.ts';
import { message } from '../src/shared/helpers.ts';
import { flattenPages, gh } from './gh.ts';
import type { Deps as BaseDeps } from './gh.ts';

interface Deps extends BaseDeps {
  now: () => Date;
}

const LABEL_LOOKS: Record<string, { color: string; description: string }> = {
  [LABEL_GATE_DESIGN]: { color: '8b6fd0', description: 'The board: this work is at the design gate' },
  [LABEL_GATE_IMPLEMENTATION]: { color: '4a9bd0', description: 'The board: this work is at the implementation gate' },
  [LABEL_GATE_PREP]: { color: '3aa89a', description: 'The board: this work is at prep for merge' },
  [LABEL_ON_OWNER]: { color: 'e8a33a', description: `The board: waiting on ${OWNER_NAME}` },
  [LABEL_READY_TO_MERGE]: { color: '4caf50', description: 'The board: checks pass and it is ready to merge' },
  [LABEL_PARKED]: { color: 'c9c6bd', description: `The board: waiting on something outside ${OWNER_NAME} and Claude` },
};

/** The labels this creates: the ones the board writes, and `in-progress`, which people and sessions set themselves. */
export const LABELS = [
  ...MANAGED_LABELS.map((name) => ({ name, ...LABEL_LOOKS[name]! })),
  { name: LABEL_IN_PROGRESS, color: '4a7bd0', description: 'Picked up: someone is working on it' },
];

interface RepoSummary { full_name: string; pushed_at: string | null }

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
      } catch (e) {
        failed = true;
        err(`${name}: ${message(e)}`);
      }
    }
    if (repos.length === 0) out(`No repos pushed to in the last ${REPO_WINDOW_DAYS} days.`);
    return failed ? 1 : 0;
  } catch (e) {
    err(message(e));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), { gh, now: () => new Date() });
}
