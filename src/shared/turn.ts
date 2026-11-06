import { LABEL_IN_PROGRESS, LABEL_ON_DANYEL, LABEL_PARKED, WAITING_ON, type WaitingOn } from './names.ts';
import type { ItemFacts, Status, Turn } from './types.ts';

export function turnOf(labels: string[]): Turn {
  if (labels.includes(LABEL_ON_DANYEL)) return 'danyel';
  if (labels.includes(LABEL_PARKED)) return 'nobody';
  if (labels.includes(LABEL_IN_PROGRESS)) return 'claude';
  return 'none';
}

const TURN_OF_WAITING_ON = Object.fromEntries(WAITING_ON.map((w) => [w.status, w.turn])) as Record<WaitingOn, Turn>;

export function effectiveTurn(labels: string[], s: Status | null): { turn: Turn; outOfSync: boolean } {
  const fromLabels = turnOf(labels);
  const turn: Turn = fromLabels === 'danyel' || s?.waitingOn === 'Danyel' ? 'danyel' : fromLabels;
  const statusSaysDanyel = s?.waitingOn === 'Danyel' && fromLabels !== 'danyel';
  const outOfSync = s !== null && (statusSaysDanyel || (fromLabels !== 'none' && TURN_OF_WAITING_ON[s.waitingOn] !== fromLabels));
  return { turn, outOfSync };
}

export function waitingSince(f: ItemFacts, s: Status | null): string | null {
  let since: string | null = null;
  for (const e of f.labelEvents) {
    if (e.label !== LABEL_ON_DANYEL) continue;
    since = e.action === 'added' ? e.at : null;
  }
  return since ?? s?.since ?? null;
}

/** One thing that can stand between a PR and being ready to merge. */
export interface MergeBlocker {
  applies: (f: ItemFacts, s: Status | null, turn: Turn) => boolean;
  /** What the Ready for merge box says when this is the reason; null when there is nothing useful to say. */
  note: (f: ItemFacts) => string | null;
  /** The item hasn't got as far as the merge step (not a PR, no prep yet, not Danyel's turn). */
  notYetAtMerge?: boolean;
  /** Worth saying even before the merge step, because it is already known to be coming. */
  showEarly?: boolean;
}

/**
 * Everything that blocks a merge, in priority order: when several apply, the earliest one with a
 * note is the one the box shows. A PR is ready to merge when none of them applies.
 */
export const MERGE_BLOCKERS: MergeBlocker[] = [
  { applies: (f) => f.kind !== 'pr', note: () => null, notYetAtMerge: true },
  { applies: (f) => f.merged, note: () => null, notYetAtMerge: true },
  { applies: (f) => !f.prepDone, note: () => null, notYetAtMerge: true },
  { applies: (_f, _s, turn) => turn !== 'danyel', note: () => null, notYetAtMerge: true },
  { applies: (f) => f.isDraft, note: () => 'draft' },
  { applies: (f) => f.stackedOnOpen, note: (f) => (f.stackedOn !== null ? `after #${f.stackedOn}` : null), showEarly: true },
  { applies: (f) => f.mergeState === 'DIRTY', note: () => 'conflicts' },
  { applies: (f) => f.mergeState === 'UNSTABLE' || f.mergeState === 'BLOCKED', note: () => 'checks failing' },
  { applies: (f) => f.behindBase || f.mergeState === 'BEHIND', note: () => 'rebase first', showEarly: true },
  { applies: (f) => f.commitsSincePrep !== 0, note: (f) => ((f.commitsSincePrep ?? 0) > 0 ? 'commits since prep' : null) },
  { applies: (f) => f.mergeState === 'UNKNOWN', note: () => 'GitHub still checking' },
  { applies: (_f, s) => (s?.questions.length ?? 0) > 0, note: () => null },
  { applies: (f) => f.mergeState !== 'CLEAN' && f.mergeState !== 'HAS_HOOKS', note: () => null },
];

/** The blockers that apply to this item, in priority order. `turn` is passed in when the caller already has it. */
export function mergeBlockers(f: ItemFacts, s: Status | null, turn: Turn = effectiveTurn(f.labels, s).turn): MergeBlocker[] {
  return MERGE_BLOCKERS.filter((b) => b.applies(f, s, turn));
}

export function isReadyToMerge(f: ItemFacts, s: Status | null): boolean {
  return mergeBlockers(f, s).length === 0;
}

/** How long since `fromIso`, like "45 min" or "1 d 16 h"; empty if the date can't be read. */
export function formatWait(fromIso: string, now: Date): string {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - from) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
