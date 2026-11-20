import { FORM_FIELD } from '../shared/answer.ts';
import { parseStatus, statusText } from '../shared/status.ts';
import { effectiveTurn, mergeBlockers } from '../shared/turn.ts';
import type { Env } from './access.ts';
import { GitHubRefused, type approvePullRequest, type fetchItem, type mergePullRequest } from './github.ts';
import { NUMBER, REPO, readPostedForm, refuse, type Refusal } from './post-answer.ts';

const KNOWN_FIELDS: readonly string[] = [FORM_FIELD.repo, FORM_FIELD.number, FORM_FIELD.head];
const COMMIT_ID = /^[0-9a-f]{40}$/;

interface MergeDeps {
  fetchItem: typeof fetchItem;
  approvePullRequest: typeof approvePullRequest;
  mergePullRequest: typeof mergePullRequest;
}

const NOT_MERGED = 'Not merged';

/** GitHub's own words, when it gave some, to follow our explanation. */
function said(e: GitHubRefused): string {
  return e.githubMessage ? ` GitHub said: ${e.githubMessage}` : '';
}

/**
 * Checks a posted Merge button and, if the PR is still ready to merge at the commit the page showed,
 * approves it as the owner when a review is required, then merges it with a merge commit. The caller
 * has already checked who is asking.
 */
export async function postMerge(
  req: Request, env: Pick<Env, 'GITHUB_TOKEN'>, deps: MergeDeps,
): Promise<Refusal | { merged: string }> {
  const posted = await readPostedForm(req, 'Merge requests', NOT_MERGED);
  if ('status' in posted) return posted;
  const form = posted;
  const seen = new Set<string>();
  for (const key of form.keys()) {
    if (seen.has(key)) return refuse(400, NOT_MERGED, `The form sent "${key}" twice.`);
    seen.add(key);
    if (!KNOWN_FIELDS.includes(key)) return refuse(400, NOT_MERGED, `The form sent a field the board doesn't know: "${key}".`);
  }
  const repo = form.get(FORM_FIELD.repo) ?? '';
  const number = form.get(FORM_FIELD.number) ?? '';
  const head = form.get(FORM_FIELD.head) ?? '';
  if (!REPO.test(repo) || repo.includes('..')) return refuse(400, NOT_MERGED, 'The form named no repository the board can read.');
  if (!NUMBER.test(number)) return refuse(400, NOT_MERGED, 'The form named no PR number.');
  if (!COMMIT_ID.test(head)) return refuse(400, NOT_MERGED, 'The form did not say which commit it was drawn from.');
  const ref = `${repo}#${number}`;

  // Read the PR again: it must still be ready by the card's own rules, at the commit the page showed.
  let item: Awaited<ReturnType<typeof fetchItem>>;
  try {
    item = await deps.fetchItem(env.GITHUB_TOKEN, repo, Number(number));
  } catch (e) {
    return refuse(502, NOT_MERGED, `Couldn't read ${ref} from GitHub: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!item) return refuse(404, NOT_MERGED, `The board can't see ${ref}.`);
  if (item.merged || item.closedAt !== null) return refuse(409, NOT_MERGED, `${ref} is already closed, so nothing was merged.`);
  const status = parseStatus(statusText(item));
  const { turn } = effectiveTurn(item.labels, status);
  const blockers = mergeBlockers(item, status, turn);
  if (blockers.length > 0) {
    const why = blockers.map((b) => b.note(item)).find((n) => n !== null);
    return refuse(409, NOT_MERGED, `${ref} isn't ready to merge any more${why ? ` (${why})` : ''}, so nothing was merged. Go back to the board to see where it is.`);
  }
  if (item.headOid !== head) {
    return refuse(409, NOT_MERGED, `${ref} has new commits since this page was drawn, so nothing was merged. Reload the board and look again.`);
  }

  if (item.reviewDecision === 'REVIEW_REQUIRED') {
    try {
      await deps.approvePullRequest(env.GITHUB_TOKEN, repo, Number(number));
    } catch (e) {
      console.error(`POST /merge: approving ${ref} failed:`, e instanceof Error ? e.message : String(e));
      if (e instanceof GitHubRefused) {
        return refuse(e.status === 403 || e.status === 404 ? 503 : 502, NOT_MERGED, `GitHub wouldn't take the board's approval of ${ref} (${e.status}), so nothing was merged.${said(e)}`);
      }
      return refuse(502, NOT_MERGED, `Couldn't approve ${ref}, so nothing was merged: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    await deps.mergePullRequest(env.GITHUB_TOKEN, repo, Number(number), head);
  } catch (e) {
    console.error(`POST /merge: merging ${ref} failed:`, e instanceof Error ? e.message : String(e));
    if (e instanceof GitHubRefused) {
      const approved = item.reviewDecision === 'REVIEW_REQUIRED' ? ' The approval was already posted.' : '';
      if (e.status === 405) return refuse(409, NOT_MERGED, `GitHub says ${ref} can't be merged right now.${said(e)}${approved}`);
      if (e.status === 409) return refuse(409, NOT_MERGED, `${ref} changed while the merge was being made, so nothing was merged. Reload the board and look again.${said(e)}${approved}`);
      if (e.status === 403 || e.status === 404) {
        return refuse(503, NOT_MERGED, `GitHub wouldn't let the board merge ${ref} (${e.status}). The Worker's GITHUB_TOKEN needs read and write access to Contents and Pull requests on this repo.${said(e)}${approved}`);
      }
      return refuse(502, NOT_MERGED, `GitHub didn't merge ${ref} (${e.status}).${said(e)}${approved}`);
    }
    return refuse(502, NOT_MERGED, `Couldn't merge ${ref}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { merged: ref };
}
