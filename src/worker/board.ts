import type { ItemFacts, StageBox, Status, Turn } from '../shared/types.ts';
import { asksForLook } from '../shared/answer.ts';
import { statusFingerprint } from '../shared/fingerprint.ts';
import { DAY_MS, PICKUP_GRACE_MS } from '../shared/names.ts';
import { extractToTest, hasStatusSection, parseStatus, statusText } from '../shared/status.ts';
import { stageStrip, whyTag } from '../shared/stage.ts';
import { effectiveTurn, formatWait, waitingSince } from '../shared/turn.ts';

export interface Card {
  facts: ItemFacts;
  status: Status | null;
  statusUnreadable: boolean;          // a status section is there, but it couldn't be read
  statusStale: boolean;               // there is a status, and a commit or comment has come since it was written
  statusEditedByHand: boolean;        // its text was changed after pr-status wrote it, so the text was read
  turn: Turn;
  outOfSync: boolean;
  strip: StageBox[];
  why: string;
  waitingSince: string | null;
  waited: string;
  toTest: string | null;
  /** The card asks the look question: a PR on the owner's turn that hasn't had prep. */
  asksLook: boolean;
  /** The fingerprint of what the card asks, sent with the answers. */
  fingerprint: string;
  /** Where the owner's answers since the status was written have got to; null when there are none. */
  answerState: AnswerState | null;
  /** The newest of those answers. */
  answerUrl: string | null;
  /** When the last of them was picked up, once every one has been; null otherwise. */
  pickedUpAt: string | null;
}

/**
 * 'awaiting-pickup': answered, and no session has claimed it yet, for up to the grace period.
 * 'not-picked-up': still unclaimed after that, so it is back with the owner to notice.
 * 'picked-up': every answer has been claimed by a Claude session.
 */
export type AnswerState = 'awaiting-pickup' | 'not-picked-up' | 'picked-up';

export interface Board {
  waiting: Card[];
  onClaude: Card[];
  quiet: Card[];
  errors: string[];
  generatedAt: string;
}

const QUIET_AFTER = 3 * DAY_MS;

function isOpen(f: ItemFacts): boolean {
  return !f.merged && f.closedAt === null;
}

function statusOf(f: ItemFacts): Status | null {
  return parseStatus(statusText(f));
}

/** Whether something happened after the status was written; false when either time is unknown. */
function changedSince(change: string | null, written: string | null): boolean {
  if (change === null || written === null) return false;
  return Date.parse(change) > Date.parse(written);
}

/** An issue hidden behind an open PR, whose labels or status say it is waiting on the owner. */
interface HiddenWait { issue: number; since: string | null }

function makeCard(f: ItemFacts, now: Date, hidden: HiddenWait | undefined): Card {
  // Read once here; everything below works from these.
  const text = statusText(f);
  const status = parseStatus(text);
  const effective = effectiveTurn(f.labels, status);
  const own = waitingSince(f, status);
  const strip = stageStrip(f, status, now, effective.turn);
  const why = whyTag(status, strip, effective.turn);
  // The PR stands in for an issue that is waiting on the owner, so the PR waits too. Unless the PR
  // already says so itself, its labels are out of step with that.
  const carried = hidden !== undefined && effective.turn !== 'owner';
  const unclaimed = f.answers.filter((a) => a.claimedAt === null);
  const claimTimes = f.answers.map((a) => a.claimedAt).filter((t): t is string => t !== null);
  const answerState: AnswerState | null =
    f.answers.length === 0 ? null
    : unclaimed.length === 0 ? 'picked-up'
    : now.getTime() - time(unclaimed[0]!.at) >= PICKUP_GRACE_MS ? 'not-picked-up'
    : 'awaiting-pickup';
  // An answer nobody picked up has waited since it was sent, not since the item was handed over.
  const since = answerState === 'not-picked-up' ? unclaimed[0]!.at : carried ? own ?? hidden.since : own;
  return {
    facts: f,
    status,
    statusUnreadable: status === null && hasStatusSection(text),
    statusStale: status !== null && changedSince(f.lastChangeAt, f.statusWrittenAt),
    statusEditedByHand: status?.editedByHand === true,
    turn: carried ? 'owner' : effective.turn,
    outOfSync: carried || effective.outOfSync,
    strip,
    why: answerState === 'not-picked-up' ? 'Answered, not picked up' : carried && !why ? `Issue #${hidden.issue} is waiting on you` : why,
    waitingSince: since,
    waited: since ? formatWait(since, now) : '',
    toTest: status?.toTest ?? extractToTest(f.body),
    asksLook: asksForLook(f, effective.turn),
    fingerprint: statusFingerprint(status),
    answerState,
    answerUrl: f.answers.at(-1)?.url ?? null,
    pickedUpAt: answerState === 'picked-up' ? claimTimes.reduce((a, b) => (time(b) > time(a) ? b : a)) : null,
  };
}

function time(iso: string): number {
  return new Date(iso).getTime();
}

export function buildBoard(items: ItemFacts[], errors: string[], now: Date): Board {
  const open = items.filter(isOpen);
  const key = (repo: string, n: number) => `${repo}#${n}`;
  // An issue stands in only until an open PR takes over from it. Once that PR is merged or closed,
  // an issue that is still open (say, one with more parts to do) comes back on its own.
  const openPrsFor = new Map<string, ItemFacts[]>();
  for (const f of open) {
    if (f.kind !== 'pr' || f.linkedIssue === null) continue;
    const k = key(f.repo, f.linkedIssue);
    openPrsFor.set(k, [...(openPrsFor.get(k) ?? []), f]);
  }
  const hasPr = (f: ItemFacts) => f.kind === 'issue' && openPrsFor.has(key(f.repo, f.number));

  // A hidden issue that is waiting on the owner must not take that signal with it.
  const hiddenWaits = new Map<string, HiddenWait>();
  for (const issue of open) {
    if (!hasPr(issue)) continue;
    const status = statusOf(issue);
    if (effectiveTurn(issue.labels, status).turn !== 'owner') continue;
    for (const pr of openPrsFor.get(key(issue.repo, issue.number))!) {
      hiddenWaits.set(key(pr.repo, pr.number), { issue: issue.number, since: waitingSince(issue, status) });
    }
  }

  const cards = open.filter((f) => !hasPr(f)).map((f) => makeCard(f, now, hiddenWaits.get(key(f.repo, f.number))));

  const waiting: Card[] = [];
  const onClaude: Card[] = [];
  const quiet: Card[] = [];
  for (const c of cards) {
    const stale = now.getTime() - time(c.facts.lastActivityAt) > QUIET_AFTER;
    // Answered is Claude's turn until the answer has gone unclaimed too long, whatever the labels still say.
    if (c.answerState === 'not-picked-up') waiting.push(c);
    else if (c.answerState !== null) onClaude.push(c);
    else if (c.turn === 'owner') waiting.push(c);
    else if (c.turn === 'nobody' || stale) quiet.push(c);
    else onClaude.push(c);
  }

  waiting.sort((a, b) => {
    if (a.waitingSince === null && b.waitingSince !== null) return 1;
    if (a.waitingSince !== null && b.waitingSince === null) return -1;
    if (a.waitingSince !== null && b.waitingSince !== null && a.waitingSince !== b.waitingSince) {
      return time(a.waitingSince) - time(b.waitingSince);
    }
    return a.facts.number - b.facts.number;
  });
  onClaude.sort((a, b) => time(b.facts.lastActivityAt) - time(a.facts.lastActivityAt));
  quiet.sort((a, b) => time(b.facts.lastActivityAt) - time(a.facts.lastActivityAt));

  return { waiting, onClaude, quiet, errors, generatedAt: now.toISOString() };
}
