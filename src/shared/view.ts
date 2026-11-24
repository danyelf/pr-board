// The board the page draws, worked out from the board's own records and answers and from what GitHub says.
// Nothing here writes anything: the label changes it lists are for the Worker to make.
import type { Facts } from './facts.ts';
import { newest } from './helpers.ts';
import { DAY_MS, FILE_AN_ISSUE, PICKUP_GRACE_MS, WORKING_STALLS_MS } from './names.ts';
import { APPROVAL_CHOICES, GATES, gatesOf, itemKey, recordNumber, turnOf, type AnswerRow, type Gate, type WorkRecord } from './work.ts';
import { labelChanges, wantedLabels } from './labels.ts';

/**
 * Where a gate stands. 'now' is the gate the work is at; once the owner has approved it and answered,
 * that is the next gate. 'on-hold' is a later gate that had been started before a move back.
 */
export type GateLook = 'approved' | 'now' | 'on-hold' | 'todo';

export interface GateBox {
  gate: Gate;
  look: GateLook;
  /** Shown from the second round on; null otherwise. */
  round: number | null;
}

/** The colour of a card's status: whose turn it is, or, once prep is complete, whether it can merge. */
export type Tone = 'owner' | 'claude' | 'ready' | 'blocked' | 'nobody';

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
  /** The card's status in a few words, such as "approve design?" or "working". */
  tag: string;
  tone: Tone;
  /** Whose turn the card shows. Once the owner has answered, it is Claude's until the answer comes back to the owner. */
  turn: 'owner' | 'claude' | 'nobody';
  waitingSince: string | null;
  startedAt: string;
  ask: string;
  toTest: string | null;
  backReason: string | null;
  questions: { n: number; text: string; choices: string[]; defaultChoice: string }[];
  approval: { choices: string[]; defaultChoice: string } | null;
  /** The note box's placeholder. When Prep is complete there is nothing to approve, so a note there means it needs changes. */
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
  'awaiting-pickup': 'sent',
  'not-picked-up': 'sent, not picked up',
  'picked-up': 'working',
  stalled: 'picked up, nothing since',
  'service-working': 'working',
  'gave-up': 'Claude gave up',
};

/** The answer states that put a card back in front of the owner. */
const BACK_WITH_OWNER: ReadonlySet<AnswerState> = new Set(['not-picked-up', 'stalled', 'gave-up']);

const APPROVE_TAG: Record<'design' | 'implementation', string> = { design: 'approve design?', implementation: 'approve build?' };

const NO_STATUS_TAG = 'no status';

const NOTE_PLACEHOLDER = 'Note';
const PREP_NOTE_PLACEHOLDER = 'Needs changes? Say what';

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

function boxesOf(r: WorkRecord, answerState: AnswerState | null): GateBox[] {
  const current = GATES.indexOf(r.gate);
  const reached = GATES.indexOf(r.reached);
  const approvedHere = r.gate !== 'prep' && r.approved[r.gate] !== undefined;
  const gates = gatesOf(r);
  const box = (gate: Gate, look: GateLook, round: number | null = null): GateBox =>
    ({ gate, look, round: round !== null && round >= 2 ? round : null });

  return gates.map((gate, i) => {
    const at = GATES.indexOf(gate);
    if (at < current) return box(gate, 'approved');
    if (at === current) {
      if (approvedHere) return box(gate, 'approved');
      // A gate that isn't complete is in its next round.
      return box(gate, 'now', r.rounds[gate] + (r.state === 'complete' ? 0 : 1));
    }
    // Once the owner has approved the current gate and answered, the work is at the next one.
    if (approvedHere && answerState !== null && gates[i - 1] === r.gate) return box(gate, 'now');
    if (at <= reached) return box(gate, 'on-hold');
    return box(gate, 'todo');
  });
}

function tagOf(r: WorkRecord, ready: ReturnType<typeof readyToMerge> | null, answerState: AnswerState | null): string {
  if (answerState !== null) return ANSWER_TAG[answerState];
  switch (r.state) {
    case 'working': return 'working';
    case 'parked': return 'parked';
    // A give-up from working hands the record back paused with no questions.
    case 'paused': return r.questions.length > 0 ? plural(r.questions.length, 'question') : 'paused';
    case 'complete':
      if (r.gate !== 'prep') return APPROVE_TAG[r.gate];
      return ready?.ready ? 'ready to merge' : `can't merge: ${ready?.reason ?? 'no PR'}`;
  }
}

function toneOf(shownTurn: CardView['turn'], ready: ReturnType<typeof readyToMerge> | null, answerState: AnswerState | null): Tone {
  if (ready !== null && answerState === null) return ready.ready ? 'ready' : 'blocked';
  return shownTurn;
}

function issueUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/issues/${n}`;
}

interface Placed { card: CardView; section: 'waiting' | 'onClaude' | 'quiet'; activity: string }

function recordCard(r: WorkRecord, answers: AnswerRow[], factsOf: (n: number | null) => Facts | undefined, now: Date): Placed | null {
  const number = recordNumber(r);
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
  // Once answered, the card is with Claude until the answer comes back to the owner, whatever the record's state says.
  const shownTurn = answerState === null ? turn : BACK_WITH_OWNER.has(answerState) ? 'owner' : 'claude';
  const gate = r.gate;
  const approvalGate = gate !== 'prep' && r.state === 'complete' && r.approved[gate] === undefined ? gate : null;
  const url = main?.url ?? (kind === 'pr' ? `https://github.com/${r.repo}/pull/${number}` : issueUrl(r.repo, number));

  const card: CardView = {
    key: itemKey(r.repo, number),
    repo: r.repo,
    number,
    title: main?.title ?? itemKey(r.repo, number),
    url,
    kind,
    version: r.version,
    boxes: boxesOf(r, answerState),
    tag: tagOf(r, ready, answerState),
    tone: toneOf(shownTurn, ready, answerState),
    turn: shownTurn,
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
    approval: approvalGate !== null ? { choices: [...APPROVAL_CHOICES[approvalGate]], defaultChoice: APPROVAL_CHOICES[approvalGate][0] } : null,
    noteLabel: prepDone ? PREP_NOTE_PLACEHOLDER : NOTE_PLACEHOLDER,
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
  if (answerState !== null) section = shownTurn === 'owner' ? 'waiting' : 'onClaude';
  else if (turn === 'owner') section = 'waiting';
  else if (turn === 'nobody' || stale) section = 'quiet';
  else section = 'onClaude';
  return { card, section, activity };
}

function noRecordCard(f: Facts): Placed {
  return {
    card: {
      key: itemKey(f.repo, f.number), repo: f.repo, number: f.number, title: f.title, url: f.url, kind: f.kind,
      version: null, boxes: [], tag: NO_STATUS_TAG, tone: 'owner', turn: 'owner', waitingSince: null, startedAt: f.createdAt,
      ask: '', toTest: null, backReason: null, questions: [], approval: null, noteLabel: NOTE_PLACEHOLDER,
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
  const byKey = new Map(facts.map((f) => [itemKey(f.repo, f.number), f]));
  const covered = new Set<string>();
  const placed: Placed[] = [];

  for (const r of records) {
    if (r.pr !== null) covered.add(itemKey(r.repo, r.pr));
    const mine = answers.filter((a) => a.workId === r.id);
    const p = recordCard(r, mine, (n) => (n === null ? undefined : byKey.get(itemKey(r.repo, n))), now);
    if (p) placed.push(p);
  }
  for (const f of facts) {
    if (f.kind === 'pr' && isOpen(f) && !covered.has(itemKey(f.repo, f.number))) placed.push(noRecordCard(f));
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
