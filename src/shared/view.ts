// The board the page draws, worked out from the board's own records and answers and from what GitHub says.
// Nothing here writes anything: the label changes it lists are for the Worker to make.
import type { Facts } from './facts.ts';
import { DAY_MS, FILE_AN_ISSUE, PICKUP_GRACE_MS, WORKING_STALLS_MS } from './names.ts';
import { APPROVAL_CHOICES, GATES, gatesOf, turnOf, type AnswerRow, type Gate, type WorkRecord } from './work.ts';
import { labelChanges, wantedLabels } from './labels.ts';

export type BoxLook = 'approved' | 'working' | 'paused' | 'complete' | 'ready' | 'blocked' | 'parked' | 'on-hold' | 'todo';

export interface GateBox {
  gate: Gate;
  look: BoxLook;
  text: string;
  /** Shown from the second round on; null otherwise. */
  round: number | null;
  /** For example "1 question". */
  badge: string | null;
}

/**
 * Where the owner's answers to the record's current version have got to.
 * 'awaiting-pickup': nobody has claimed one yet, within the grace period.
 * 'not-picked-up': still unclaimed after it, so it is back with the owner.
 * 'picked-up': a Claude session claimed them.
 * 'stalled': a session claimed them long enough ago that it seems to be gone.
 * 'service-working': the Mac service claimed them and is running a session.
 * 'gave-up': that session ended without writing a new status.
 */
export type AnswerState = 'awaiting-pickup' | 'not-picked-up' | 'picked-up' | 'stalled' | 'service-working' | 'gave-up';

export interface CardView {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  kind: 'pr' | 'issue';
  /** The record's version, sent back with an answer; null for a PR with no record. */
  version: number | null;
  boxes: GateBox[];
  tag: string;
  turn: 'owner' | 'claude' | 'nobody';
  waitingSince: string | null;
  startedAt: string;
  ask: string;
  toTest: string | null;
  backReason: string | null;
  questions: { n: number; text: string; choices: string[]; defaultChoice: string }[];
  approval: { choices: string[]; defaultChoice: string } | null;
  /** "needs changes" when Prep is complete, since there is nothing to approve there; otherwise "Note". */
  noteLabel: string;
  answerState: AnswerState | null;
  lastAnswer: { at: string; note: string; choices: Record<string, string> } | null;
  /** When a session gave up on the answer, where its output is. */
  gaveUpHint: string | null;
  links: { pr: string | null; issue: string | null; preview: string | null; merge: string | null };
  screenshots: string[];
  /** What the Worker should change on GitHub so the labels match the card. */
  labels: { add: string[]; remove: string[] };
}

export interface BoardView {
  waiting: CardView[];
  onClaude: CardView[];
  quiet: CardView[];
  /** Every open card, in the order the work started, newest first. */
  everything: CardView[];
  errors: string[];
  generatedAt: string;
}

const QUIET_AFTER = 3 * DAY_MS;

const ANSWER_TAG: Record<AnswerState, string> = {
  'awaiting-pickup': 'Answered, waiting for Claude to pick it up',
  'not-picked-up': 'Answered, not picked up',
  'picked-up': 'Claude is working on your answers',
  stalled: 'Picked up, but nothing since',
  'service-working': 'Mac session working on it',
  'gave-up': 'A session tried and gave up',
};

/** The answer states that put a card back in front of the owner. */
const BACK_WITH_OWNER: ReadonlySet<AnswerState> = new Set(['not-picked-up', 'stalled', 'gave-up']);

const WORKING_TAG: Record<Gate, string> = { design: 'Claude designing', implementation: 'Claude building', prep: 'Claude prepping' };

const NO_STATUS_TAG = 'No status written';

/** Whether the PR can be merged as prep left it; when it can't, the first reason, in a fixed order. */
export function readyToMerge(r: WorkRecord, f: Facts | undefined): { ready: true } | { ready: false; reason: string } {
  const no = (reason: string) => ({ ready: false as const, reason });
  if (r.pr === null || !f || f.kind !== 'pr') return no('no PR');
  if (f.isDraft) return no('draft');
  if (f.stackedOn !== null && f.stackedOnOpen) return no(`after #${f.stackedOn}`);
  if (r.prepSha !== f.headSha) return no('commits since prep');
  if (f.mergeState === 'DIRTY') return no('conflicts');
  if (f.mergeState === 'BEHIND' || f.behindBase) return no('rebase first');
  if (f.mergeState === 'UNSTABLE' || f.checks === 'FAILURE' || f.checks === 'ERROR') return no('checks failing');
  if (f.checks === 'PENDING' || f.checks === 'EXPECTED') return no('checks still running');
  if (f.mergeState === 'UNKNOWN' || f.mergeState === null) return no('GitHub still checking');
  if (f.mergeState === 'CLEAN' || f.mergeState === 'HAS_HOOKS') return { ready: true };
  // The owner supplies a required review when merging, so that alone doesn't hold the PR back.
  if (f.mergeState === 'BLOCKED' && f.reviewDecision === 'REVIEW_REQUIRED' && (f.checks === 'SUCCESS' || f.checks === null)) return { ready: true };
  return no('GitHub is blocking the merge');
}

function time(iso: string): number {
  return Date.parse(iso);
}

function newest(times: string[]): string {
  return times.reduce((a, b) => (time(b) > time(a) ? b : a));
}

function isOpen(f: Facts): boolean {
  return !f.merged && f.closedAt === null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The answer state, the answer it is about, and, for the states back with the owner, when it came back. */
function answerStateOf(
  r: WorkRecord,
  answers: AnswerRow[],
  now: Date,
): { state: AnswerState; answer: AnswerRow; since: string | null } | null {
  const current = answers.filter((a) => a.version === r.version);
  const live = current.filter((a) => a.gaveUpAt === null);
  if (live.length === 0) {
    const gaveUp = current.filter((a) => a.gaveUpAt !== null).at(-1);
    return gaveUp ? { state: 'gave-up', answer: gaveUp, since: gaveUp.claimedAt ?? gaveUp.gaveUpAt } : null;
  }
  const last = live.at(-1)!;
  const unclaimed = live.filter((a) => a.claimedAt === null);
  if (unclaimed.length > 0) {
    const first = unclaimed[0]!;
    return now.getTime() - time(first.at) >= PICKUP_GRACE_MS
      ? { state: 'not-picked-up', answer: last, since: first.at }
      : { state: 'awaiting-pickup', answer: last, since: null };
  }
  if (live.every((a) => a.claimedBy === 'service')) return { state: 'service-working', answer: last, since: null };
  const claimedAt = newest(live.filter((a) => a.claimedBy === 'session').map((a) => a.claimedAt!));
  return now.getTime() - time(claimedAt) >= WORKING_STALLS_MS
    ? { state: 'stalled', answer: last, since: claimedAt }
    : { state: 'picked-up', answer: last, since: null };
}

function boxesOf(r: WorkRecord, ready: ReturnType<typeof readyToMerge> | null, answerState: AnswerState | null): GateBox[] {
  const current = GATES.indexOf(r.gate);
  const reached = GATES.indexOf(r.reached);
  const approvedHere = r.gate !== 'prep' && r.approved[r.gate] !== undefined;
  const gates = gatesOf(r);
  const box = (gate: Gate, look: BoxLook, text: string, round: number | null = null, badge: string | null = null): GateBox =>
    ({ gate, look, text, round: round !== null && round >= 2 ? round : null, badge });

  return gates.map((gate, i) => {
    const at = GATES.indexOf(gate);
    if (at < current) return box(gate, 'approved', '✓ approved');
    if (at === current) {
      if (approvedHere) return box(gate, 'approved', '✓ approved');
      const handed = r.rounds[gate];
      if (r.state === 'complete') {
        if (gate === 'prep') return ready?.ready ? box(gate, 'ready', 'ready for merge', handed) : box(gate, 'blocked', ready?.reason ?? 'no PR', handed);
        return box(gate, 'complete', 'complete: your approval', handed);
      }
      // A gate that isn't complete is in its next round.
      if (r.state === 'working') return box(gate, 'working', 'Claude working', handed + 1);
      // A give-up from working hands the record back paused with no questions; it then has no badge.
      if (r.state === 'paused') return box(gate, 'paused', 'Claude paused', handed + 1, r.questions.length > 0 ? plural(r.questions.length, 'question') : null);
      return box(gate, 'parked', 'parked', handed + 1);
    }
    // Once the owner has approved the current gate, the next one carries the line saying where the answer is.
    if (approvedHere && answerState !== null && gates[i - 1] === r.gate) return box(gate, 'working', ANSWER_TAG[answerState]);
    if (at <= reached) return box(gate, 'on-hold', 'on hold');
    return box(gate, 'todo', '');
  });
}

function tagOf(r: WorkRecord, ready: ReturnType<typeof readyToMerge> | null, answerState: AnswerState | null): string {
  if (answerState !== null) return ANSWER_TAG[answerState];
  switch (r.state) {
    case 'working': return WORKING_TAG[r.gate];
    case 'parked': return 'Parked';
    case 'paused': return `${plural(r.questions.length, 'question')} for you`;
    case 'complete':
      if (r.gate === 'design') return 'Design ready for your approval';
      if (r.gate === 'implementation') return 'Ready for your look';
      return ready?.ready ? 'Ready to merge' : `Can't merge yet: ${ready?.reason ?? 'no PR'}`;
  }
}

function issueUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/issues/${n}`;
}

interface Placed { card: CardView; section: 'waiting' | 'onClaude' | 'quiet'; activity: string }

function recordCard(r: WorkRecord, answers: AnswerRow[], factsOf: (n: number | null) => Facts | undefined, now: Date): Placed | null {
  const number = r.pr ?? r.issue!;
  const kind = r.pr !== null ? 'pr' : 'issue';
  const main = factsOf(number);
  if (main && !isOpen(main)) return null;
  const pr = r.pr !== null ? main : undefined;
  const issueNumber = r.issue ?? pr?.linkedIssue ?? null;
  const issue = r.issue !== null && r.pr === null ? main : factsOf(issueNumber);

  const prepDone = r.gate === 'prep' && r.state === 'complete';
  const ready = prepDone ? readyToMerge(r, pr) : null;
  const found = answerStateOf(r, answers, now);
  const answerState = found?.state ?? null;
  const turn = turnOf(r.state);
  const askingApproval = r.state === 'complete' && r.gate !== 'prep' && r.approved[r.gate] === undefined;
  const url = main?.url ?? (kind === 'pr' ? `https://github.com/${r.repo}/pull/${number}` : issueUrl(r.repo, number));

  const card: CardView = {
    key: `${r.repo}#${number}`,
    repo: r.repo,
    number,
    title: main?.title ?? `${r.repo}#${number}`,
    url,
    kind,
    version: r.version,
    boxes: boxesOf(r, ready, answerState),
    tag: tagOf(r, ready, answerState),
    turn,
    waitingSince: found?.since ?? r.turnSince,
    startedAt: r.startedAt,
    ask: r.ask,
    toTest: r.toTest,
    // The reason for the last move back matters only while a later gate is on hold.
    backReason: GATES.indexOf(r.gate) < GATES.indexOf(r.reached) ? r.backReason : null,
    // Every one of Claude's questions also offers "file an issue", last; an approval never does.
    questions: r.state === 'paused' || r.state === 'complete'
      ? r.questions.map((q) => ({ ...q, choices: [...q.choices.filter((c) => c !== FILE_AN_ISSUE), FILE_AN_ISSUE] }))
      : [],
    approval: askingApproval && r.gate !== 'prep'
      ? { choices: [...APPROVAL_CHOICES[r.gate]], defaultChoice: APPROVAL_CHOICES[r.gate][0] }
      : null,
    noteLabel: prepDone ? 'needs changes' : 'Note',
    answerState,
    lastAnswer: found ? { at: found.answer.at, note: found.answer.note, choices: found.answer.choices } : null,
    gaveUpHint: found?.state === 'gave-up' ? found.answer.giveUpHint : null,
    links: {
      pr: r.pr !== null ? (pr?.url ?? url) : null,
      issue: issueNumber !== null ? (issue?.url ?? issueUrl(r.repo, issueNumber)) : null,
      preview: main?.previewUrl ?? null,
      merge: ready?.ready ? url : null,
    },
    screenshots: main?.screenshots ?? [],
    labels: labelChanges(main?.labels ?? [], wantedLabels({ gate: r.gate, turn, ready: ready?.ready === true })),
  };

  const activity = newest([main?.lastActivityAt, r.writtenAt, r.confirmedAt].filter((t): t is string => t != null));
  const stale = now.getTime() - time(activity) > QUIET_AFTER;
  let section: Placed['section'];
  if (answerState !== null) section = BACK_WITH_OWNER.has(answerState) ? 'waiting' : 'onClaude';
  else if (turn === 'owner') section = 'waiting';
  else if (turn === 'nobody' || stale) section = 'quiet';
  else section = 'onClaude';
  return { card, section, activity };
}

function noRecordCard(f: Facts): Placed {
  return {
    card: {
      key: `${f.repo}#${f.number}`, repo: f.repo, number: f.number, title: f.title, url: f.url, kind: f.kind,
      version: null, boxes: [], tag: NO_STATUS_TAG, turn: 'owner', waitingSince: null, startedAt: f.createdAt,
      ask: '', toTest: null, backReason: null, questions: [], approval: null, noteLabel: 'Note',
      answerState: null, lastAnswer: null, gaveUpHint: null,
      links: { pr: f.url, issue: f.linkedIssue !== null ? issueUrl(f.repo, f.linkedIssue) : null, preview: f.previewUrl, merge: null },
      screenshots: f.screenshots,
      // The board keeps labels only on items with a record.
      labels: { add: [], remove: [] },
    },
    section: 'waiting',
    activity: f.lastActivityAt,
  };
}

export function buildView(records: WorkRecord[], answers: AnswerRow[], facts: Facts[], errors: string[], now: Date): BoardView {
  const byKey = new Map(facts.map((f) => [`${f.repo}#${f.number}`, f]));
  const covered = new Set<string>();
  const placed: Placed[] = [];

  for (const r of records) {
    if (r.pr !== null) covered.add(`${r.repo}#${r.pr}`);
    const mine = answers.filter((a) => a.workId === r.id);
    const p = recordCard(r, mine, (n) => (n === null ? undefined : byKey.get(`${r.repo}#${n}`)), now);
    if (p) placed.push(p);
  }
  for (const f of facts) {
    if (f.kind === 'pr' && isOpen(f) && !covered.has(`${f.repo}#${f.number}`)) placed.push(noRecordCard(f));
  }

  const byActivity = (a: Placed, b: Placed) => time(b.activity) - time(a.activity) || a.card.key.localeCompare(b.card.key);
  const waiting = placed.filter((p) => p.section === 'waiting').sort((a, b) => {
    const x = a.card.waitingSince;
    const y = b.card.waitingSince;
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      const d = time(x) - time(y);
      if (d !== 0) return d;
    }
    return a.card.key.localeCompare(b.card.key);
  });
  const everything = [...placed].sort((a, b) => time(b.card.startedAt) - time(a.card.startedAt) || a.card.key.localeCompare(b.card.key));

  return {
    waiting: waiting.map((p) => p.card),
    onClaude: placed.filter((p) => p.section === 'onClaude').sort(byActivity).map((p) => p.card),
    quiet: placed.filter((p) => p.section === 'quiet').sort(byActivity).map((p) => p.card),
    everything: everything.map((p) => p.card),
    errors,
    generatedAt: now.toISOString(),
  };
}
