// Finding, claiming and describing the owner's answers from the board. The watcher and the Mac
// service both use this, so the rule for a waiting answer and the printed form have one definition.
import { CLAIM_REACTION, answerLines, answersCurrentStatus, isClaimReaction, parseAnswer, type Answer, type CommentSeen } from '../src/shared/answer.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { descriptionEditedAt, parseStatus, statusWrittenAt } from '../src/shared/status.ts';
import { flattenPages, readItem, refString } from './gh.ts';
import type { Gh, ItemRead, Ref } from './gh.ts';
import { message } from './poll.ts';

export interface RestComment {
  id: number; user: { login: string } | null; body: string; html_url: string; created_at: string; updated_at: string;
  reactions?: { eyes?: number };
}

/** An answer comment nobody has claimed yet, with the text the item's status lived in when it was read. */
export interface Found { ref: Ref; id: number; url: string; createdAt: string; answer: Answer; statusText: string }

const base = (ref: Ref) => `repos/${ref.owner}/${ref.repo}`;

// A PR's description edits are only in the GraphQL API.
const PR_EDITED_QUERY = 'query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $n) { lastEditedAt createdAt } } }';

/**
 * When the item's status was written, by the shared rule. A PR's last description edit costs a
 * GraphQL call, so it is asked for only when the status recorded no time of its own.
 */
export async function writtenAt(gh: Gh, ref: Ref, item: ItemRead<RestComment>): Promise<string | null> {
  if (!item.isPr) return statusWrittenAt(item.statusText, item.statusComment?.updated_at ?? null);
  const recorded = statusWrittenAt(item.statusText, null);
  if (recorded) return recorded;
  const pr = JSON.parse(await gh(['api', 'graphql', '-f', `query=${PR_EDITED_QUERY}`, '-f', `owner=${ref.owner}`, '-f', `repo=${ref.repo}`, '-F', `n=${ref.n}`,
    '-q', '.data.repository.pullRequest'])) as { lastEditedAt: string | null; createdAt: string } | null;
  return pr ? descriptionEditedAt(pr) : null;
}

/** The 👀 reactions on a comment. Skips the call when GitHub's count says there are none. */
async function eyesOn(gh: Gh, ref: Ref, c: RestComment): Promise<{ login: string | undefined; content: string }[]> {
  if (c.reactions?.eyes === 0) return [];
  const url = `${base(ref)}/issues/comments/${c.id}/reactions?content=${CLAIM_REACTION}&per_page=100`;
  const reactions = flattenPages(await gh(['api', url, '--paginate', '--slurp'])) as { user: { login: string } | null; content?: string }[];
  return reactions.map((r) => ({ login: r.user?.login, content: r.content ?? CLAIM_REACTION }));
}

/** The owner's answers on one open item that nobody has claimed, oldest first. */
async function waitingOn(gh: Gh, ref: Ref, item: ItemRead<RestComment>): Promise<Found[]> {
  const written = await writtenAt(gh, ref, item);
  const found: Found[] = [];
  for (const c of item.comments) {
    const seen: CommentSeen = { login: c.user?.login, body: c.body, createdAt: c.created_at };
    if (!answersCurrentStatus(seen, written)) continue;
    // Reactions are read only for the answers to the current status.
    if ((await eyesOn(gh, ref, c)).some((r) => isClaimReaction(r.login, r.content))) continue;
    found.push({ ref, id: c.id, url: c.html_url, createdAt: c.created_at, answer: parseAnswer(c.body)!, statusText: item.statusText });
  }
  return found;
}

/**
 * Reads each item. Drops, saying so, the ones that are closed or merged, since no answer will come
 * for them. Returns the owner's answers still waiting on the rest, and why any item couldn't be read,
 * so one bad item doesn't hide the others.
 */
export async function waitingAnswers(gh: Gh, refs: Ref[], say: (line: string) => void): Promise<{ found: Found[]; failed: string[] }> {
  const found: Found[] = [];
  const failed: string[] = [];
  for (const ref of [...refs]) {
    try {
      const item = await readItem<RestComment>(gh, ref);
      if (!item.open) {
        refs.splice(refs.indexOf(ref), 1);
        say(`${refString(ref)} is closed or merged; no longer watching it.`);
        continue;
      }
      found.push(...(await waitingOn(gh, ref, item)));
    } catch (e) {
      failed.push(`Couldn't read ${refString(ref)}: ${message(e)}`);
    }
  }
  return { found, failed };
}

/**
 * Adds this account's 👀 to the answer. GitHub says 201 when the reaction is new and 200 when this
 * account had already reacted, which means another session running as the same account claimed it
 * first (null). The reaction's id is what unclaim needs; it is null if GitHub's reply held none.
 */
export async function claim(gh: Gh, f: Pick<Found, 'ref' | 'id'>): Promise<{ reactionId: number | null } | null> {
  const res = await gh(['api', '-X', 'POST', `${base(f.ref)}/issues/comments/${f.id}/reactions`, '-f', `content=${CLAIM_REACTION}`, '--include']);
  if (!/^HTTP\/\S+\s+201\b/.test(res)) return null;
  let id: unknown = null;
  try {
    id = (JSON.parse(res.split(/\r?\n\r?\n/).slice(1).join('\n\n')) as { id?: unknown }).id;
  } catch {
    // No readable body.
  }
  return { reactionId: typeof id === 'number' ? id : null };
}

/** Takes this account's 👀 back off an answer, so the board shows it as waiting again. */
export async function unclaim(gh: Gh, f: Pick<Found, 'ref' | 'id'>, reactionId: number | null): Promise<void> {
  if (reactionId === null) throw new Error(`GitHub didn't say which reaction was the claim on comment ${f.id}; take this account's 👀 off by hand`);
  await gh(['api', '-X', 'DELETE', `${base(f.ref)}/issues/comments/${f.id}/reactions/${reactionId}`]);
}

/** The answers in words, with whether they still answer the item's questions as they were just read. */
export function describe(f: Found): string {
  const lines = [`${refString(f.ref)}: ${f.url}`];
  const status = parseStatus(f.statusText);
  const current = statusFingerprint(status);
  const matches = current === f.answer.fingerprint;
  lines.push(matches
    ? `  fingerprint ${f.answer.fingerprint} matches the current status`
    : `  fingerprint ${f.answer.fingerprint} does NOT match the current status (${current}): the questions changed after these answers were sent. Don't apply them; ask again.`);
  for (const l of answerLines(matches ? status?.questions ?? [] : [], f.answer.answers)) {
    if (l.choice !== null) lines.push(`  ${l.label} → ${l.choice}`);
  }
  if (f.answer.note) lines.push(`  Note: ${f.answer.note.split('\n').join('\n    ')}`);
  return lines.join('\n');
}
