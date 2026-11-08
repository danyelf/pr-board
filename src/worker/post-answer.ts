import { LOOK_KEY, asksForLook, checkAnswer, renderAnswer } from '../shared/answer.ts';
import { OWNER_LOGIN } from '../shared/config.ts';
import { statusFingerprint } from '../shared/fingerprint.ts';
import { parseStatus } from '../shared/status.ts';
import type { fetchItem, postComment } from './github.ts';

export const MAX_BODY_BYTES = 16 * 1024;

/** owner/repo#N, the way the board names an item. */
export const ITEM_REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d{0,9})$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const FINGERPRINT = /^[0-9a-f]{8}$/;
const QUESTION_FIELD = /^q([1-9]\d{0,3})$/;

export interface AnswerDeps {
  fetchItem: typeof fetchItem;
  postComment: typeof postComment;
}

/** What to send back: a page saying why nothing was posted, or the item whose answers were posted. */
export type AnswerResult = { status: number; title: string; text: string } | { sent: string };

const refuse = (status: number, title: string, text: string): AnswerResult => ({ status, title, text });

/** The request body as text, or null when it is longer than `max` bytes. Stops reading as soon as it is. */
async function readLimited(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * Checks a posted answer form and, if it is sound and still answers the item's current questions,
 * posts it as a comment from the owner's account. The caller has already checked who is asking.
 */
export async function postAnswer(
  req: Request, env: { GITHUB_TOKEN: string; GITHUB_ANSWER_TOKEN?: string }, deps: AnswerDeps,
): Promise<AnswerResult> {
  // A form on another site can post here with the owner's Access cookie; only this page's own forms may.
  if (req.headers.get('Origin') !== new URL(req.url).origin) {
    return refuse(403, 'Not sent', 'Answers can only be sent from the board itself.');
  }
  if (!(req.headers.get('Content-Type') ?? '').startsWith('application/x-www-form-urlencoded')) {
    return refuse(415, 'Not sent', 'Answers must be sent as a form.');
  }
  const text = await readLimited(req, MAX_BODY_BYTES);
  if (text === null) return refuse(413, 'Not sent', `The answers were more than ${MAX_BODY_BYTES / 1024} KB.`);

  const answerToken = env.GITHUB_ANSWER_TOKEN ?? '';
  if (answerToken === '') {
    return refuse(503, 'Not sent', "Answering isn't set up: the Worker has no GITHUB_ANSWER_TOKEN to post with.");
  }

  const form = new URLSearchParams(text);
  const seen = new Set<string>();
  const answers: Record<string, string> = {};
  for (const [key, value] of form) {
    if (seen.has(key)) return refuse(400, 'Not sent', `The form sent "${key}" twice.`);
    seen.add(key);
    const q = QUESTION_FIELD.exec(key);
    if (q) answers[q[1]!] = value;
    else if (key === LOOK_KEY) answers[LOOK_KEY] = value;
    else if (!['repo', 'number', 'fingerprint', 'note'].includes(key)) return refuse(400, 'Not sent', `The form sent a field the board doesn't know: "${key}".`);
  }
  const repo = form.get('repo') ?? '';
  const number = form.get('number') ?? '';
  const fingerprint = form.get('fingerprint') ?? '';
  const note = form.get('note') ?? '';
  if (!REPO.test(repo) || repo.includes('..')) return refuse(400, 'Not sent', 'The form named no repository the board can read.');
  if (!NUMBER.test(number)) return refuse(400, 'Not sent', 'The form named no item number.');
  if (!FINGERPRINT.test(fingerprint)) return refuse(400, 'Not sent', 'The form did not say which questions it answers.');
  const ref = `${repo}#${number}`;

  // Read the item again with the read-only token: it must still be there, open, and asking the same questions.
  let item: Awaited<ReturnType<typeof fetchItem>>;
  try {
    item = await deps.fetchItem(env.GITHUB_TOKEN, repo, Number(number));
  } catch (e) {
    return refuse(502, 'Not sent', `Couldn't read ${ref} from GitHub: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!item) return refuse(404, 'Not sent', `The board can't see ${ref}.`);
  if (item.merged || item.closedAt !== null) return refuse(409, 'Not sent', `${ref} is closed, so the answers were not sent.`);
  const status = parseStatus(item.kind === 'pr' ? item.body : item.statusCommentBody ?? '');
  if (statusFingerprint(status) !== fingerprint) {
    return refuse(409, 'Not sent', `The questions on ${ref} have changed since this page was loaded, so the answers were not sent. Go back to the board to see the new questions.`);
  }
  const problem = checkAnswer(status, asksForLook(item, status), { answers, note });
  if (problem) return refuse(400, 'Not sent', problem);

  let posted: { login: string | null };
  try {
    posted = await deps.postComment(answerToken, repo, Number(number), renderAnswer(status, { fingerprint, answers, note }));
  } catch (e) {
    return refuse(502, 'Not sent', `GitHub didn't take the answers for ${ref}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (posted.login !== OWNER_LOGIN) {
    return refuse(500, 'Sent under the wrong account', `The answers on ${ref} went up as ${posted.login ?? 'an unknown account'}, not ${OWNER_LOGIN}, so Claude won't pick them up. GITHUB_ANSWER_TOKEN must belong to ${OWNER_LOGIN}.`);
  }
  return { sent: ref };
}
