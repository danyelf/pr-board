import type { ItemFacts, StageBox, Status, Turn } from '../shared/types.ts';
import { extractToTest, hasStatusSection, parseStatus } from '../shared/status.ts';
import { stageStrip, whyTag } from '../shared/stage.ts';
import { buildTimeline, type Timeline } from '../shared/timeline.ts';
import { effectiveTurn, formatWait, waitingSince } from '../shared/turn.ts';

export interface Card {
  facts: ItemFacts;
  status: Status | null;
  statusUnreadable: boolean;          // a status section is there, but it couldn't be read
  turn: Turn;
  outOfSync: boolean;
  strip: StageBox[];
  why: string;
  waitingSince: string | null;
  waited: string;
  toTest: string | null;
}

export interface Board {
  waiting: Card[];
  onClaude: Card[];
  quiet: Card[];
  timeline: Timeline;
  errors: string[];
  generatedAt: string;
}

const DAY = 24 * 3_600_000;
const QUIET_AFTER = 3 * DAY;

function isOpen(f: ItemFacts): boolean {
  return !f.merged && f.closedAt === null;
}

function statusText(f: ItemFacts): string {
  return f.kind === 'pr' ? f.body : f.statusCommentBody ?? '';
}

function statusOf(f: ItemFacts): Status | null {
  return parseStatus(statusText(f));
}

/** An issue hidden behind an open PR, whose labels or status say it is waiting on Danyel. */
interface HiddenWait { issue: number; since: string | null }

function makeCard(f: ItemFacts, now: Date, hidden: HiddenWait | undefined): Card {
  const status = statusOf(f);
  const effective = effectiveTurn(f.labels, status);
  const own = waitingSince(f, status);
  const why = whyTag(f, status, now);
  // The PR stands in for an issue that is waiting on Danyel, so the PR waits too. Unless the PR
  // already says so itself, its labels are out of step with that.
  const carried = hidden !== undefined && effective.turn !== 'danyel';
  const since = carried ? own ?? hidden.since : own;
  return {
    facts: f,
    status,
    statusUnreadable: status === null && hasStatusSection(statusText(f)),
    turn: carried ? 'danyel' : effective.turn,
    outOfSync: carried || effective.outOfSync,
    strip: stageStrip(f, status, now),
    why: carried && !why ? `Issue #${hidden.issue} is waiting on you` : why,
    waitingSince: since,
    waited: since ? formatWait(since, now) : '',
    toTest: status?.toTest ?? extractToTest(f.body),
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

  // A hidden issue that is waiting on Danyel must not take that signal with it.
  const hiddenWaits = new Map<string, HiddenWait>();
  for (const issue of open) {
    if (!hasPr(issue)) continue;
    const status = statusOf(issue);
    if (effectiveTurn(issue.labels, status).turn !== 'danyel') continue;
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
    if (c.turn === 'danyel') waiting.push(c);
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

  const timelineItems = items.filter((f) => !hasPr(f));

  const alsoWaiting = new Map([...hiddenWaits].map(([k, w]) => [k, w.since]));

  return { waiting, onClaude, quiet, timeline: buildTimeline(timelineItems, now, 7, alsoWaiting), errors, generatedAt: now.toISOString() };
}
