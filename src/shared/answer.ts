// The answer comment the board posts from the owner's account, read back by the watcher.
// Both sides use this module, so the format has one definition.
import { STATUS_CLOSE, STATUS_OPEN, jsonForComment } from './status.ts';
import { effectiveTurn } from './turn.ts';
import type { ItemFacts, Question, Status } from './types.ts';

/** Means: go with the default, and file the question as a new issue to decide later. */
export const FILE_AN_ISSUE = 'file an issue';

/** Asked on every PR at the owner's look, after any questions Claude wrote. */
export const LOOK_QUESTION = 'How does it look?';
export const LOOK_CHOICES = ['looks good, prep for merge', 'needs changes', FILE_AN_ISSUE] as const;
export const LOOK_DEFAULT = LOOK_CHOICES[0];
/** The key the look answer has among the answers; the questions are keyed by their numbers. */
export const LOOK_KEY = 'look';

export const NOTE_MAX = 2000;

const ANSWER_OPEN = '<!-- pr-board answer ';
const ANSWER_CLOSE = ' -->';

export interface Answer {
  /** The fingerprint of the status that was answered. */
  fingerprint: string;
  /** The choice for each question, by question number, and the look answer under LOOK_KEY. */
  answers: Record<string, string>;
  note: string;
}

/** True for an open PR, on the owner's turn, that hasn't had prep for merge: it is waiting for the owner's look. */
export function asksForLook(f: Pick<ItemFacts, 'kind' | 'merged' | 'prepDone' | 'labels'>, s: Status | null): boolean {
  return f.kind === 'pr' && !f.merged && !f.prepDone && effectiveTurn(f.labels, s).turn === 'owner';
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
  if ([STATUS_OPEN, STATUS_CLOSE, ANSWER_OPEN.trim()].some((m) => note.includes(m))) return "The note can't contain a status or answer marker";
  if (Object.keys(form.answers).length === 0 && note === '') return 'Nothing to send: no answers and no note';
  return null;
}

/** The comment: one line a program reads, then the same answers for people. */
export function renderAnswer(s: Status | null, a: Answer): string {
  const note = cleanNote(a.note);
  const lines = [
    `${ANSWER_OPEN}${jsonForComment({ v: 1, fingerprint: a.fingerprint, answers: a.answers, note })}${ANSWER_CLOSE}`,
    '**Answers from PR Board**',
    '',
  ];
  for (const q of s?.questions ?? []) {
    const choice = a.answers[String(q.n)];
    lines.push(`${q.n}. ${q.text} → ${choice ? `**${choice}**` : '(no answer)'}`);
  }
  const look = a.answers[LOOK_KEY];
  if (look) lines.push(`${LOOK_QUESTION} → **${look}**`);
  if (note) lines.push('', 'Note:', ...note.split('\n').map((l) => `> ${l}`));
  return lines.join('\n');
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
  if (d.v !== 1 || typeof d.fingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(d.fingerprint) || typeof d.note !== 'string') return null;
  if (typeof d.answers !== 'object' || d.answers === null || Array.isArray(d.answers)) return null;
  const answers = d.answers as Record<string, unknown>;
  if (!Object.values(answers).every((v) => typeof v === 'string')) return null;
  return { fingerprint: d.fingerprint, answers: answers as Record<string, string>, note: d.note };
}
