import { FORM_FIELD, asksForLook, checkAnswer, questionOfField, renderAnswer } from '../shared/answer.ts';
import { OWNER_LOGIN } from '../shared/config.ts';
import { FINGERPRINT_RE, statusFingerprint } from '../shared/fingerprint.ts';
import { parseStatus, statusText } from '../shared/status.ts';
import { effectiveTurn } from '../shared/turn.ts';
import { ANSWERING_NOT_SET_UP, answerToken, type Env } from './access.ts';
import type { fetchItem, postComment } from './github.ts';

// Room for a full note of NOTE_MAX characters, every one of them escaped to several bytes, and the answers.
const MAX_BODY_BYTES = 32 * 1024;

/** owner/repo#N, the way the board names an item. */
export const ITEM_REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d{0,9})$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const KNOWN_FIELDS: readonly string[] = [FORM_FIELD.repo, FORM_FIELD.number, FORM_FIELD.fingerprint, FORM_FIELD.note];

interface AnswerDeps {
  fetchItem: typeof fetchItem;
  postComment: typeof postComment;
}

/** What to send back: a page saying why nothing was posted, or the item whose answers were posted. */
type AnswerResult = { status: number; title: string; text: string; link?: { href: string; text: string } } | { sent: string };

const refuse = (status: number, title: string, text: string, link?: { href: string; text: string }): AnswerResult =>
  ({ status, title, text, ...(link ? { link } : {}) });

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
  req: Request, env: Pick<Env, 'GITHUB_TOKEN' | 'GITHUB_ANSWER_TOKEN'>, deps: AnswerDeps,
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

  const token = answerToken(env);
  if (token === null) return refuse(503, 'Not sent', ANSWERING_NOT_SET_UP);

  const form = new URLSearchParams(text);
  const seen = new Set<string>();
  const answers: Record<string, string> = {};
  for (const [key, value] of form) {
    if (seen.has(key)) return refuse(400, 'Not sent', `The form sent "${key}" twice.`);
    seen.add(key);
    const q = questionOfField(key);
    if (q !== null) answers[q] = value;
    else if (key === FORM_FIELD.look) answers[FORM_FIELD.look] = value;
    else if (!KNOWN_FIELDS.includes(key)) return refuse(400, 'Not sent', `The form sent a field the board doesn't know: "${key}".`);
  }
  const repo = form.get(FORM_FIELD.repo) ?? '';
  const number = form.get(FORM_FIELD.number) ?? '';
  const fingerprint = form.get(FORM_FIELD.fingerprint) ?? '';
  const note = form.get(FORM_FIELD.note) ?? '';
  if (!REPO.test(repo) || repo.includes('..')) return refuse(400, 'Not sent', 'The form named no repository the board can read.');
  if (!NUMBER.test(number)) return refuse(400, 'Not sent', 'The form named no item number.');
  if (!FINGERPRINT_RE.test(fingerprint)) return refuse(400, 'Not sent', 'The form did not say which questions it answers.');
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
  // A page left open after answering, or open in two tabs, would otherwise send the same answers twice.
  const earlier = item.answers.at(-1);
  if (earlier) {
    return refuse(409, 'Not sent', `You have already answered ${ref} since Claude last wrote its status, so these answers were not sent. Claude will write a new status once it has acted on them.`, { href: earlier.url, text: 'Your answers' });
  }
  // Read exactly as the page read it, so a status edited by hand is checked against its text, as shown.
  const status = parseStatus(statusText(item));
  const { turn } = effectiveTurn(item.labels, status);
  if (turn !== 'owner') {
    return refuse(409, 'Not sent', `${ref} isn't waiting on you any more, so the answers were not sent. Go back to the board to see where it is.`);
  }
  if (statusFingerprint(status) !== fingerprint) {
    return refuse(409, 'Not sent', `The questions on ${ref} have changed since this page was loaded, so the answers were not sent. Go back to the board to see the new questions.`);
  }
  const problem = checkAnswer(status, asksForLook(item, turn), { answers, note });
  if (problem) return refuse(400, 'Not sent', problem);
  let body: string;
  try {
    body = renderAnswer(status, { fingerprint, answers, note });
  } catch (e) {
    return refuse(400, 'Not sent', `${e instanceof Error ? e.message : String(e)}, so they were not sent. Rewrite the status with pr-status set.`);
  }

  let posted: { login: string | null };
  try {
    posted = await deps.postComment(token, repo, Number(number), body);
  } catch (e) {
    return refuse(502, 'Not sent', `GitHub didn't take the answers for ${ref}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (posted.login !== OWNER_LOGIN) {
    return refuse(500, 'Sent under the wrong account', `The answers on ${ref} went up as ${posted.login ?? 'an unknown account'}, not ${OWNER_LOGIN}, so Claude won't pick them up. GITHUB_ANSWER_TOKEN must belong to ${OWNER_LOGIN}.`);
  }
  return { sent: ref };
}
