// Finding, claiming and describing the owner's answers from the board. The watcher and the Mac
// service both use this, so the rule for a waiting answer and the printed form have one definition.
import { LOOK_KEY, LOOK_QUESTION, answersCurrentStatus, isWaitingAnswer, parseAnswer, type Answer, type CommentSeen } from '../src/shared/answer.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { parseStatus } from '../src/shared/status.ts';
import type { Status } from '../src/shared/types.ts';
import { flattenPages, readItem, readStatusText, refString } from './gh.ts';
import type { Gh, ItemRead, Ref } from './gh.ts';
import { message } from './poll.ts';

export interface RestComment {
  id: number; user: { login: string } | null; body: string; html_url: string; created_at: string; updated_at: string;
  reactions?: { eyes?: number };
}

/** An answer comment nobody has claimed yet. */
export interface Found { ref: Ref; id: number; url: string; createdAt: string; answer: Answer }

const base = (ref: Ref) => `repos/${ref.owner}/${ref.repo}`;

// A PR's description edits are only in the GraphQL API.
const PR_EDITED_QUERY = 'query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $n) { lastEditedAt createdAt } } }';

/**
 * When the item's status was written, so answers to an earlier status aren't taken for answers to
 * this one: the time pr-status recorded in it, else (for a section edited by hand, or one written
 * before that time was recorded) when the description or the status comment was last edited.
 */
export async function statusWrittenAt(gh: Gh, ref: Ref, item: ItemRead<RestComment>): Promise<string | null> {
  const written = parseStatus(item.statusText)?.writtenAt;
  if (written) return written;
  if (!item.isPr) return item.statusComment?.updated_at ?? null;
  const at = await gh(['api', 'graphql', '-f', `query=${PR_EDITED_QUERY}`, '-f', `owner=${ref.owner}`, '-f', `repo=${ref.repo}`, '-F', `n=${ref.n}`,
    '-q', '.data.repository.pullRequest | .lastEditedAt // .createdAt']);
  return at.trim() || null;
}

/** The 👀 reactions on a comment. Skips the call when GitHub's count says there are none. */
async function eyesOn(gh: Gh, ref: Ref, c: RestComment): Promise<{ login: string | undefined; content: string }[]> {
  if (c.reactions?.eyes === 0) return [];
  const url = `${base(ref)}/issues/comments/${c.id}/reactions?content=eyes&per_page=100`;
  const reactions = flattenPages(await gh(['api', url, '--paginate', '--slurp'])) as { user: { login: string } | null; content?: string }[];
  return reactions.map((r) => ({ login: r.user?.login, content: r.content ?? 'eyes' }));
}

/**
 * Reads each item. Drops, saying so, the ones that are closed or merged, since no answer will come
 * for them. Returns the owner's answers still waiting on the rest, oldest first within each item.
 */
export async function waitingAnswers(gh: Gh, refs: Ref[], say: (line: string) => void): Promise<Found[]> {
  const found: Found[] = [];
  for (const ref of [...refs]) {
    const item = await readItem<RestComment>(gh, ref);
    if (!item.open) {
      refs.splice(refs.indexOf(ref), 1);
      say(`${refString(ref)} is closed or merged; no longer watching it.`);
      continue;
    }
    const writtenAt = await statusWrittenAt(gh, ref, item);
    for (const c of item.comments) {
      const seen: CommentSeen = { login: c.user?.login, body: c.body, createdAt: c.created_at };
      // Reactions are read only for the answers to the current status.
      if (!answersCurrentStatus(seen, writtenAt) || !isWaitingAnswer(seen, writtenAt, await eyesOn(gh, ref, c))) continue;
      found.push({ ref, id: c.id, url: c.html_url, createdAt: c.created_at, answer: parseAnswer(c.body)! });
    }
  }
  return found;
}

/**
 * Adds this account's 👀 to the answer. GitHub says 201 when the reaction is new and 200 when this
 * account had already reacted, which means another session running as the same account claimed it
 * first (null). The reaction's id is what unclaim needs; it is null if GitHub's reply held none.
 */
export async function claim(gh: Gh, f: Pick<Found, 'ref' | 'id'>): Promise<{ reactionId: number | null } | null> {
  const res = await gh(['api', '-X', 'POST', `${base(f.ref)}/issues/comments/${f.id}/reactions`, '-f', 'content=eyes', '--include']);
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

/** The answers in words, with whether they still answer the item's current questions. */
export async function describe(gh: Gh, f: Found): Promise<string> {
  const lines = [`${refString(f.ref)}: ${f.url}`];
  let current: string | null = null;
  let status: Status | null = null;
  try {
    status = parseStatus(await readStatusText(gh, f.ref));
    current = statusFingerprint(status);
  } catch (e) {
    lines.push(`  Couldn't read the current status (${message(e)}); check the fingerprint ${f.answer.fingerprint} by hand before applying these.`);
  }
  const matches = current === f.answer.fingerprint;
  if (current !== null) {
    lines.push(matches
      ? `  fingerprint ${f.answer.fingerprint} matches the current status`
      : `  fingerprint ${f.answer.fingerprint} does NOT match the current status (${current}): the questions changed after these answers were sent. Don't apply them; ask again.`);
  }
  for (const [key, value] of Object.entries(f.answer.answers)) {
    if (key === LOOK_KEY) continue;
    const q = matches ? status?.questions.find((x) => String(x.n) === key) : undefined;
    lines.push(q ? `  ${q.n}. ${q.text} → ${value}` : `  ${key} → ${value}`);
  }
  const look = f.answer.answers[LOOK_KEY];
  if (look) lines.push(`  ${LOOK_QUESTION} → ${look}`);
  if (f.answer.note) lines.push(`  Note: ${f.answer.note.split('\n').join('\n    ')}`);
  return lines.join('\n');
}
