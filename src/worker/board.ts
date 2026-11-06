import type { ItemFacts, StageBox, Status, Turn } from '../shared/types.ts';
import { extractToTest, parseStatus } from '../shared/status.ts';
import { stageStrip, whyTag } from '../shared/stage.ts';
import { buildTimeline, type Timeline } from '../shared/timeline.ts';
import { effectiveTurn, formatWait, waitingSince } from '../shared/turn.ts';

export interface Card {
  facts: ItemFacts;
  status: Status | null;
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

function statusOf(f: ItemFacts): Status | null {
  return parseStatus(f.kind === 'pr' ? f.body : f.statusCommentBody ?? '');
}

function makeCard(f: ItemFacts, now: Date): Card {
  const status = statusOf(f);
  const effective = effectiveTurn(f.labels, status);
  const since = waitingSince(f, status);
  return {
    facts: f,
    status,
    turn: effective.turn,
    outOfSync: effective.outOfSync,
    strip: stageStrip(f, status, now),
    why: whyTag(f, status, now),
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
  // An issue stands in only until its PR exists, whether that PR is still open or already merged.
  const standsInFor = new Set(
    items.filter((f) => f.kind === 'pr' && f.linkedIssue !== null && (f.merged || f.closedAt === null)).map((f) => `${f.repo}#${f.linkedIssue}`),
  );
  const hasPr = (f: ItemFacts) => f.kind === 'issue' && standsInFor.has(`${f.repo}#${f.number}`);
  const cards = open.filter((f) => !hasPr(f)).map((f) => makeCard(f, now));

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

  return { waiting, onClaude, quiet, timeline: buildTimeline(timelineItems, now), errors, generatedAt: now.toISOString() };
}
