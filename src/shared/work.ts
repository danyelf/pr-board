// The workflow model: a piece of work moves through three gates, in one of four states, and the board
// holds the record. These are the rules for what a new status may do to a record, and for what an answer may say.
import { FILE_AN_ISSUE, NOTE_MAX } from './names.ts';

export const GATES = ['design', 'implementation', 'prep'] as const;
export type Gate = (typeof GATES)[number];

export const STATES = ['working', 'paused', 'complete', 'parked'] as const;
export type State = (typeof STATES)[number];

export interface Question {
  n: number;
  text: string;
  choices: string[];
  defaultChoice: string;
}

export interface WorkRecord {
  id: number;
  repo: string;
  issue: number | null;
  pr: number | null;
  hasDesign: boolean;
  gate: Gate;
  state: State;
  /** The furthest gate the work has been to. */
  reached: Gate;
  ask: string;
  questions: Question[];
  toTest: string | null;
  backReason: string | null;
  /** The time the owner approved each gate. Prep has no approval. */
  approved: Partial<Record<'design' | 'implementation', string>>;
  /** How many times each gate has been handed to the owner as complete. */
  rounds: Record<Gate, number>;
  prepSha: string | null;
  version: number;
  turnSince: string;
  writtenAt: string;
  confirmedAt: string | null;
  startedAt: string;
  endedAt: string | null;
  endedHow: 'merged' | 'closed' | null;
}

export interface SetInput {
  gate: Gate;
  state: State;
  ask: string;
  questions: string[];
  toTest: string | null;
  reason: string | null;
  noDesign: boolean;
  headSha: string | null;
  isPr: boolean;
}

export interface AnswerInput {
  version: number;
  /** The chosen answer for each question, keyed by the question's number. */
  choices: Record<string, string>;
  approval: string | null;
  note: string;
}

export interface AnswerRow {
  id: number;
  workId: number;
  version: number;
  at: string;
  choices: Record<string, string>;
  approval: string | null;
  note: string;
  claimedAt: string | null;
  claimedBy: 'session' | 'service' | null;
  stateBefore: State | null;
  gaveUpAt: string | null;
  /** When a session gave up on this answer, where its output is. */
  giveUpHint: string | null;
}

/** The fields of a record a new status works out; the rest come from the item and from the record's start and end. */
export type RecordFields = Omit<WorkRecord, 'id' | 'repo' | 'issue' | 'pr' | 'startedAt' | 'endedAt' | 'endedHow' | 'confirmedAt'>;

/** A new status as the board takes it: the status itself, the issue it belongs to, and the PR it replaces. */
export type StatusInput = SetInput & { issue: number | null; replaces: number | null };

/** A record on the board and some of its answers, as the board's routes return them. */
export interface Found { record: WorkRecord; answers: AnswerRow[] }

/** A status or an answer the board will not accept. The message says why, in words for whoever sent it. */
export class Refused extends Error {}

/** The choice that sends a gate back to Claude; it must come with a note saying what to change. */
export const NEEDS_CHANGES = 'needs changes';

/** What the board says when "needs changes" comes without a note. */
export const NEEDS_A_NOTE = 'Say what needs changing';

export const APPROVAL_CHOICES: Record<'design' | 'implementation', readonly [string, string]> = {
  design: ['approve, build it', NEEDS_CHANGES],
  implementation: ['looks good, prep for merge', NEEDS_CHANGES],
};

export const GATE_NAMES: Record<Gate, string> = { design: 'Design', implementation: 'Implementation', prep: 'Prep for merge' };

/** The names the board's page shows. */
export const GATE_SHORT_NAMES: Record<Gate, string> = { design: 'Design', implementation: 'Build', prep: 'Prep' };

/** The item a record is known by: its PR when it has one, otherwise its issue. */
export function recordNumber(r: Pick<WorkRecord, 'pr' | 'issue'>): number {
  return r.pr ?? r.issue!;
}

/** The "owner/repo#N" key an item goes by on the board. */
export function itemKey(repo: string, n: number): string {
  return `${repo}#${n}`;
}

export function turnOf(state: State): 'owner' | 'claude' | 'nobody' {
  if (state === 'paused' || state === 'complete') return 'owner';
  return state === 'working' ? 'claude' : 'nobody';
}

/** The gates a piece of work goes through, in order. */
export function gatesOf(r: Pick<WorkRecord, 'hasDesign'>): Gate[] {
  return r.hasDesign ? [...GATES] : GATES.filter((g) => g !== 'design');
}

/** Reads "text (**a** | b)": the trailing group holds the choices, and exactly one is in bold. */
export function parseQuestion(text: string, n: number): Question {
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text.trim());
  if (!match) throw new Refused(`Question ${n} has no choices. Write it as: Question? (**default** | other)`);
  const parts = (match[2] ?? '').split('|').map((p) => p.trim());
  if (parts.some((p) => p === '')) throw new Refused(`Question ${n} has an empty choice`);
  const bold = parts.filter((p) => /^\*\*.+\*\*$/.test(p));
  if (bold.length !== 1) throw new Refused(`Question ${n} needs exactly one choice in bold to be the default, and has ${bold.length}`);
  const choices = parts.map((p) => (/^\*\*.+\*\*$/.test(p) ? p.slice(2, -2).trim() : p));
  const defaultChoice = bold[0]!.slice(2, -2).trim();
  return { n, text: (match[1] ?? '').trim(), choices, defaultChoice };
}

function noLineBreak(label: string, value: string | null): void {
  if (value !== null && /[\r\n]/.test(value)) throw new Refused(`${label} must be one line`);
}

export function applySet(
  prev: WorkRecord | null,
  input: SetInput,
  now: string,
): RecordFields {
  noLineBreak('The ask', input.ask);
  noLineBreak('The how-to-test', input.toTest);
  noLineBreak('The reason', input.reason);
  input.questions.forEach((q, i) => noLineBreak(`Question ${i + 1}`, q));

  if (input.gate === 'prep' && !input.isPr) throw new Refused('Prep for merge needs a PR, and this is an issue');
  if (prev && input.noDesign) throw new Refused('--no-design is for the first status of a piece of work only');
  if (prev === null && input.gate === 'prep') throw new Refused('Work can\'t start at Prep for merge');

  const questions = input.questions.map((q, i) => parseQuestion(q, i + 1));
  if (input.state === 'paused' && questions.length === 0) throw new Refused('A paused status needs at least one question');
  if (input.state === 'parked' && input.ask.trim() === '') throw new Refused('A parked status needs an ask saying what it waits on');
  if (input.state === 'complete' && input.gate === 'implementation' && !input.toTest?.trim()) {
    throw new Refused('Implementation complete needs a how-to-test');
  }
  if (input.state === 'complete' && input.gate === 'prep' && !input.headSha) {
    throw new Refused('Prep complete needs the PR\'s head commit, and none was found');
  }

  const hasDesign = prev ? prev.hasDesign || input.gate === 'design' : !input.noDesign;
  const target = GATES.indexOf(input.gate);
  const approved = { ...(prev?.approved ?? {}) };
  let backReason = prev?.backReason ?? null;

  if (prev && target < GATES.indexOf(prev.gate)) {
    if (!input.reason?.trim()) throw new Refused(`Going back to ${GATE_NAMES[input.gate]} needs a reason`);
    for (const g of ['design', 'implementation'] as const) if (GATES.indexOf(g) >= target) delete approved[g];
    backReason = input.reason;
  } else {
    for (const g of gatesOf({ hasDesign })) {
      if (g === 'prep' || GATES.indexOf(g) >= target) continue;
      if (!approved[g]) throw new Refused(`${GATE_NAMES[g]} hasn't been approved, so work can't move on to ${GATE_NAMES[input.gate]}`);
    }
  }

  const rounds = { ...(prev?.rounds ?? { design: 0, implementation: 0, prep: 0 }) };
  // Writing complete again at a gate that is already complete (to fix the ask, say) is not a new round.
  const alreadyComplete = prev?.state === 'complete' && prev.gate === input.gate;
  if (input.state === 'complete' && !alreadyComplete) rounds[input.gate] += 1;

  const reached = prev && GATES.indexOf(prev.reached) > target ? prev.reached : input.gate;
  const turnChanged = !prev || turnOf(prev.state) !== turnOf(input.state);

  return {
    hasDesign,
    gate: input.gate,
    state: input.state,
    reached,
    ask: input.ask,
    questions,
    toTest: input.toTest,
    backReason,
    approved,
    rounds,
    prepSha: input.gate === 'prep' && input.state === 'complete' ? input.headSha : null,
    version: (prev?.version ?? 0) + 1,
    turnSince: turnChanged ? now : prev!.turnSince,
    writtenAt: now,
  };
}

/**
 * Whether the answer fits the record it was sent to; null when it does, otherwise the refusal.
 * The one-answer-per-version rule needs the other answers, so the store checks that, not this.
 */
export function checkAnswer(r: WorkRecord, a: AnswerInput): string | null {
  if (a.version !== r.version) return 'This changed since you opened it. Reload the card and answer again.';
  for (const [key, choice] of Object.entries(a.choices)) {
    const q = r.questions.find((x) => String(x.n) === key);
    if (!q) return `There is no question ${key}`;
    if (choice !== FILE_AN_ISSUE && !q.choices.includes(choice)) return `"${choice}" isn't one of the choices for question ${key}`;
  }
  if (a.note.length > NOTE_MAX) return `The note is longer than ${NOTE_MAX} characters`;
  if (a.approval !== null) {
    if (r.state !== 'complete' || r.gate === 'prep') return 'There is nothing to approve here';
    if (!APPROVAL_CHOICES[r.gate].includes(a.approval)) return `"${a.approval}" isn't one of the choices for ${GATE_NAMES[r.gate]}`;
    if (a.approval === NEEDS_CHANGES && a.note.trim() === '') return NEEDS_A_NOTE;
  }
  return null;
}
