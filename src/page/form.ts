// A card's answer form, as data: what it starts with, whether it can be sent, and the answer it sends.
import type { CardView } from '../shared/view.ts';
import { NEEDS_A_NOTE, NEEDS_CHANGES, type AnswerInput } from '../shared/work.ts';

export interface FormState {
  /** The chosen answer for each question, keyed by the question's number. */
  choices: Record<string, string>;
  approval: string | null;
  note: string;
  /** True once the owner has changed a choice or typed in the note, so a refresh must not replace the card. */
  touched: boolean;
}

/**
 * Whether the card offers its questions and approval. Once the owner has answered this version they are
 * not offered again; the card shows what was sent instead. A new version brings them back, and so does a
 * session giving up on the answer, so the owner can answer again.
 */
export function offersQuestions(c: CardView): boolean {
  return c.answerState === null || c.answerState === 'gave-up';
}

/** Whether the card can be answered at all: a PR with no status written has no record to answer. */
export function canAnswer(c: CardView): boolean {
  return c.version !== null;
}

export function initialForm(c: CardView): FormState {
  const choices: Record<string, string> = {};
  for (const q of c.questions) choices[String(q.n)] = q.defaultChoice;
  return { choices, approval: c.approval?.defaultChoice ?? null, note: '', touched: false };
}

/**
 * The form for the fresh card the board sent back with a refusal. The typed note is kept, since it was the
 * owner's own words; the choices start from the defaults again, because the questions may have changed.
 */
export function afterRefusal(fresh: CardView, typedNote: string): FormState {
  return { ...initialForm(fresh), note: typedNote, touched: typedNote !== '' };
}

/** Why the form can't be sent as it stands, in words for the owner; null when it can. */
export function formProblem(c: CardView, s: FormState): string | null {
  const offered = offersQuestions(c) && (c.questions.length > 0 || c.approval !== null);
  if (offered && s.approval === NEEDS_CHANGES && s.note.trim() === '') return `${NEEDS_A_NOTE}.`;
  if (!offered && s.note.trim() === '') return `Type a note to send.`;
  return null;
}

export function toAnswer(c: CardView, s: FormState): AnswerInput {
  if (c.version === null) throw new Error(`${c.key} has no status written, so there is nothing to answer`);
  if (!offersQuestions(c)) return { version: c.version, choices: {}, approval: null, note: s.note };
  const choices: Record<string, string> = {};
  for (const q of c.questions) {
    const chosen = s.choices[String(q.n)];
    if (chosen !== undefined) choices[String(q.n)] = chosen;
  }
  return { version: c.version, choices, approval: c.approval ? s.approval : null, note: s.note };
}
