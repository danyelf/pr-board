// The backlog: a proposal of which open issues to pick up next and which to close, the owner's answers to it,
// and the issues picked up and waiting for a session. None of it is a piece of work with gates; it has tables of its own.
import { DAY_MS } from './names.ts';
import { Refused } from './work.ts';

export const PICK_UP = 'pick up';
export const LATER = 'later';
export const CLOSE = 'close';
/** The choices for each issue on a proposal, in the order the card shows them. */
export const PROPOSAL_CHOICES = [PICK_UP, LATER, CLOSE] as const;
export type ProposalChoice = (typeof PROPOSAL_CHOICES)[number];
/** The choices as a sentence says them: "pick up, later or close". */
export const CHOICES_TEXT = `${PROPOSAL_CHOICES.slice(0, -1).join(', ')} or ${PROPOSAL_CHOICES.at(-1)}`;

/** The most issues one proposal may suggest picking up. */
export const MAX_PICKS = 5;
/** An issue the owner said "later" to is left out of proposals for this long. */
export const LATER_MS = 14 * DAY_MS;

export interface ProposalItem {
  issue: number;
  title: string;
  suggestion: ProposalChoice;
  reason: string;
}

export interface Proposal {
  id: number;
  repo: string;
  askedAt: string;
  startedAt: string | null;
  writtenAt: string | null;
  items: ProposalItem[] | null;
  answeredAt: string | null;
  /** The owner's choice for each issue, keyed by the issue's number. */
  answers: Record<string, ProposalChoice> | null;
  note: string | null;
  carriedAt: string | null;
  /** When every choice had been carried out; carried but not done means the service stopped partway. */
  carryDoneAt: string | null;
  noteStartedAt: string | null;
  doneAt: string | null;
  failedAt: string | null;
  failure: string | null;
}

export interface Pickup {
  id: number;
  repo: string;
  issue: number;
  proposalId: number | null;
  askedAt: string;
  startedAt: string | null;
  doneAt: string | null;
  failedAt: string | null;
  failure: string | null;
  droppedAt: string | null;
}

/** What the Mac service saw at its last look: how many sessions it had running, its limit, and the repos it serves. */
export interface ServiceLook {
  at: string;
  running: number;
  max: number;
  repos: string[];
}

/** An open issue of a repo, as the backlog counts it. */
export interface BacklogIssue {
  number: number;
  labels: string[];
}

/** A repo's open issues as GitHub listed them; `complete` is false when there were more than the list holds. */
export interface RepoIssues {
  repo: string;
  issues: BacklogIssue[];
  complete: boolean;
}

/** An issue the proposal session is told to leave out, and why. */
export interface Skip {
  issue: number;
  why: string;
}

/** What one --item says, before the board adds the issue's title. */
export type ItemInput = Omit<ProposalItem, 'title'>;

/** Reads "#25 | pick up | why this one", as `pr-status propose` takes each item. */
export function parseItem(text: string): ItemInput {
  const parts = text.split('|').map((p) => p.trim());
  const shape = `Write each item as "#N | ${PICK_UP} | reason", with ${CHOICES_TEXT}`;
  if (parts.length < 3) throw new Refused(`"${text}" isn't an item. ${shape}`);
  const [num, choice, ...rest] = parts;
  const m = /^#?(\d+)$/.exec(num!);
  if (!m) throw new Refused(`"${num}" isn't an issue number. ${shape}`);
  if (!(PROPOSAL_CHOICES as readonly string[]).includes(choice!)) throw new Refused(`"${choice}" isn't ${CHOICES_TEXT}. ${shape}`);
  const reason = rest.join(' | ').trim();
  if (reason === '') throw new Refused(`#${m[1]} has no reason. ${shape}`);
  return { issue: Number(m[1]), suggestion: choice as ProposalChoice, reason };
}

/** Why a list of items can't be a proposal, or null when it can. */
export function itemsProblem(items: ItemInput[]): string | null {
  const seen = new Set<number>();
  for (const it of items) {
    if (seen.has(it.issue)) return `#${it.issue} is in the list twice`;
    seen.add(it.issue);
    if (/[\r\n]/.test(it.reason)) return `The reason for #${it.issue} must be one line`;
  }
  const picks = items.filter((i) => i.suggestion === PICK_UP).length;
  if (picks > MAX_PICKS) return `A proposal may suggest picking up at most ${MAX_PICKS} issues, and this one suggests ${picks}`;
  return null;
}

/** Whether a proposal is still in the board's hands, as opposed to done or failed. */
export function isUnderWay(p: Proposal): boolean {
  return p.doneAt === null && p.failedAt === null;
}

/** Why the proposal suggested a picked-up issue, when it came from one of these proposals. */
export function pickupReason(u: Pickup, proposals: Proposal[]): string | null {
  return proposals.find((p) => p.id === u.proposalId)?.items?.find((i) => i.issue === u.issue)?.reason ?? null;
}
