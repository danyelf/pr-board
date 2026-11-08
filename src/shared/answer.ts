// The answer comment the board posts from the owner's account, read back by the watcher.
// Both sides use this module, so the format, the form and the rules for an answer have one definition.
import { OWNER_LOGIN } from './config.ts';
import { FINGERPRINT_RE } from './fingerprint.ts';
import { STATUS_CLOSE, STATUS_OPEN, hasStatusSection, jsonForComment } from './status.ts';
import type { ItemFacts, Question, Status, Turn } from './types.ts';

/** Means: go with the default, and file the question as a new issue to decide later. */
export const FILE_AN_ISSUE = 'file an issue';

/** Asked on every PR at the owner's look, after any questions Claude wrote. */
export const LOOK_QUESTION = 'How does it look?';
export const LOOK_CHOICES = ['looks good, prep for merge', 'needs changes', FILE_AN_ISSUE] as const;
export const LOOK_DEFAULT = LOOK_CHOICES[0];
/** The key the look answer has among the answers; the questions are keyed by their numbers. */
export const LOOK_KEY = 'look';

export const NOTE_MAX = 2000;

/** The names of the answer form's fields, besides one per question (see questionField). */
export const FORM_FIELD = { repo: 'repo', number: 'number', fingerprint: 'fingerprint', note: 'note', look: LOOK_KEY } as const;

/** The form field the page uses for question n. */
export function questionField(n: number): string {
  return `q${n}`;
}

/** The question number a form field is for, as the answers key it, or null when it isn't a question's field. */
export function questionOfField(field: string): string | null {
  return /^q([1-9]\d{0,3})$/.exec(field)?.[1] ?? null;
}

const ANSWER_OPEN = '<!-- pr-board answer ';
const ANSWER_CLOSE = ' -->';
const ANSWER_MARKER = ANSWER_OPEN.trim();

export interface Answer {
  /** The fingerprint of the status that was answered. */
  fingerprint: string;
  /** The choice for each question, by question number, and the look answer under LOOK_KEY. */
  answers: Record<string, string>;
  note: string;
}

/** True for an open PR, on the owner's turn, that hasn't had prep for merge: it is waiting for the owner's look. */
export function asksForLook(f: Pick<ItemFacts, 'kind' | 'merged' | 'prepDone'>, turn: Turn): boolean {
  return f.kind === 'pr' && !f.merged && !f.prepDone && turn === 'owner';
}

/** What can be answered to a question: its own choices, then "file an issue". */
export function choicesFor(q: Question): string[] {
  return [...q.choices.filter((c) => c !== FILE_AN_ISSUE), FILE_AN_ISSUE];
}

function cleanNote(note: string): string {
  return note.replace(/\r\n?/g, '\n').trim();
}

/** Why these answers can't be sent to this status, or null if they can. */
export function checkAnswer(s: Status | null, asksLook: boolean, form: Omit<Answer, 'fingerprint'>): string | null {
  for (const [key, value] of Object.entries(form.answers)) {
    if (key === LOOK_KEY) {
      if (!asksLook) return "This item isn't waiting for your look";
      if (!(LOOK_CHOICES as readonly string[]).includes(value)) return `"${value}" isn't one of the choices for the look`;
      continue;
    }
    const q = s?.questions.find((x) => String(x.n) === key);
    if (!q) return `There is no question ${key}`;
    if (!choicesFor(q).includes(value)) return `"${value}" isn't one of the choices for question ${key}`;
  }
  const note = cleanNote(form.note);
  if (note.length > NOTE_MAX) return `The note is longer than ${NOTE_MAX} characters`;
  if ([STATUS_OPEN, STATUS_CLOSE, ANSWER_MARKER].some((m) => note.includes(m))) return "The note can't contain a status or answer marker";
  if (Object.keys(form.answers).length === 0 && note === '') return 'Nothing to send: no answers and no note';
  return null;
}

/** On one line, so a line break in a question or a choice can't start a line of its own in the comment. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The comment: one line a program reads, then the same answers for people. Throws if the comment
 * would hold a status section or a second answer marker (which a question's text could carry in),
 * since either would be read as something the comment isn't.
 */
export function renderAnswer(s: Status | null, a: Answer): string {
  const note = cleanNote(a.note);
  const lines = [
    `${ANSWER_OPEN}${jsonForComment({ v: 1, fingerprint: a.fingerprint, answers: a.answers, note })}${ANSWER_CLOSE}`,
    '**Answers from PR Board**',
    '',
  ];
  for (const q of s?.questions ?? []) {
    const choice = a.answers[String(q.n)];
    lines.push(`${q.n}. ${oneLine(q.text)} → ${choice ? `**${oneLine(choice)}**` : '(no answer)'}`);
  }
  const look = a.answers[LOOK_KEY];
  if (look) lines.push(`${LOOK_QUESTION} → **${look}**`);
  if (note) lines.push('', 'Note:', ...note.split('\n').map((l) => `> ${l}`));
  const body = lines.join('\n');
  if (hasStatusSection(body)) throw new Error('The answers would hold a status section');
  if (body.split(ANSWER_MARKER).length > 2) throw new Error('The answers would hold a second answer marker');
  return body;
}

/** The answer in a comment, or null when the comment isn't one or its first line can't be read. */
export function parseAnswer(body: string): Answer | null {
  const first = body.split(/\r?\n/, 1)[0]!.trim();
  if (!first.startsWith(ANSWER_OPEN) || !first.endsWith(ANSWER_CLOSE)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(first.slice(ANSWER_OPEN.length, -ANSWER_CLOSE.length));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== 1 || typeof d.fingerprint !== 'string' || !FINGERPRINT_RE.test(d.fingerprint) || typeof d.note !== 'string') return null;
  if (typeof d.answers !== 'object' || d.answers === null || Array.isArray(d.answers)) return null;
  const answers = d.answers as Record<string, unknown>;
  if (!Object.values(answers).every((v) => typeof v === 'string')) return null;
  return { fingerprint: d.fingerprint, answers: answers as Record<string, string>, note: d.note };
}

/** A comment holding the owner's answers: from the owner's login, in the answer format. */
export function isOwnerAnswer(login: string | null | undefined, body: string): boolean {
  return login === OWNER_LOGIN && parseAnswer(body) !== null;
}

/** A reaction that claims an answer for a Claude session: 👀 from anyone but the owner. */
export function isClaimReaction(login: string | null | undefined, content: string): boolean {
  return typeof login === 'string' && login !== OWNER_LOGIN && content.toLowerCase() === 'eyes';
}

/** A comment as both GitHub's APIs give it, reduced to what the answer rules need. */
export interface CommentSeen { login: string | null | undefined; body: string; createdAt: string }

/**
 * The owner's answer to the current status: an answer comment from the owner, written after the
 * status was. With no status time, every answer counts.
 */
export function answersCurrentStatus(c: CommentSeen, statusWrittenAt: string | null): boolean {
  return isOwnerAnswer(c.login, c.body) && (statusWrittenAt === null || Date.parse(c.createdAt) > Date.parse(statusWrittenAt));
}

/**
 * An answer still waiting for a Claude session: the owner's answer to the current status that
 * nobody but the owner has reacted 👀 to. Its reactions only need reading once the first part holds.
 */
export function isWaitingAnswer(
  c: CommentSeen, statusWrittenAt: string | null, reactions: { login: string | null | undefined; content: string }[],
): boolean {
  return answersCurrentStatus(c, statusWrittenAt) && !reactions.some((r) => isClaimReaction(r.login, r.content));
}
