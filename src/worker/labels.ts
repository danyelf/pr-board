import {
  LABEL_GATE_DESIGN, LABEL_GATE_IMPLEMENTATION, LABEL_GATE_PREP, LABEL_ON_OWNER, LABEL_PARKED, LABEL_READY_TO_MERGE,
} from '../shared/names.ts';
import type { Gate } from '../shared/work.ts';

/** The labels the board writes on GitHub. It never touches any other label, `in-progress` included. */
export const MANAGED_LABELS: readonly string[] = [
  LABEL_GATE_DESIGN, LABEL_GATE_IMPLEMENTATION, LABEL_GATE_PREP, LABEL_ON_OWNER, LABEL_READY_TO_MERGE, LABEL_PARKED,
];

const GATE_LABEL: Record<Gate, string> = {
  design: LABEL_GATE_DESIGN,
  implementation: LABEL_GATE_IMPLEMENTATION,
  prep: LABEL_GATE_PREP,
};

/** The board's labels a card should carry: its gate, whose turn it is, and whether it is ready to merge. */
export function wantedLabels(card: { gate: Gate | null; turn: 'owner' | 'claude' | 'nobody'; ready: boolean }): string[] {
  const labels: string[] = [];
  if (card.gate) labels.push(GATE_LABEL[card.gate]);
  if (card.turn === 'owner') labels.push(LABEL_ON_OWNER);
  if (card.ready) labels.push(LABEL_READY_TO_MERGE);
  if (card.turn === 'nobody') labels.push(LABEL_PARKED);
  return labels;
}

/** What to add and remove to turn the labels an item has into the ones wanted, leaving every unmanaged label alone. */
export function labelChanges(have: string[], want: string[]): { add: string[]; remove: string[] } {
  return {
    add: want.filter((l) => MANAGED_LABELS.includes(l) && !have.includes(l)),
    remove: have.filter((l) => MANAGED_LABELS.includes(l) && !want.includes(l)),
  };
}
