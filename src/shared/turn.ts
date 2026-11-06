import type { ItemFacts, Status, Turn } from './types.ts';

export function turnOf(labels: string[]): Turn {
  if (labels.includes('on danyel')) return 'danyel';
  if (labels.includes('parked')) return 'nobody';
  if (labels.includes('in-progress')) return 'claude';
  return 'none';
}

const TURN_OF_WAITING_ON: Record<Status['waitingOn'], Turn> = {
  Danyel: 'danyel',
  Claude: 'claude',
  nobody: 'nobody',
};

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
    if (e.label !== 'on danyel') continue;
    since = e.action === 'added' ? e.at : null;
  }
  return since ?? s?.since ?? null;
}

export function isReadyToMerge(f: ItemFacts, s: Status | null): boolean {
  return (
    f.kind === 'pr' &&
    !f.merged &&
    !f.isDraft &&
    f.prepDone &&
    f.commitsSincePrep === 0 &&
    effectiveTurn(f.labels, s).turn === 'danyel' &&
    (s?.questions.length ?? 0) === 0 &&
    (f.mergeState === 'CLEAN' || f.mergeState === 'HAS_HOOKS') &&
    !f.behindBase &&
    !f.stackedOnOpen
  );
}

export function formatWait(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
