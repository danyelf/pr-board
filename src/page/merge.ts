// What a refresh changes on the page. A card the owner is answering is never replaced: it is only flagged.
import type { BoardView, CardView } from '../shared/view.ts';

export function plan(
  oldCards: Map<string, CardView>,
  next: BoardView,
  touched: Set<string>,
): { redraw: string[]; flagChanged: string[]; add: string[]; remove: string[] } {
  const redraw: string[] = [];
  const flagChanged: string[] = [];
  const add: string[] = [];
  const nextKeys = new Set<string>();
  for (const c of next.everything) {
    nextKeys.add(c.key);
    const old = oldCards.get(c.key);
    if (!old) add.push(c.key);
    else if (JSON.stringify(old) !== JSON.stringify(c)) (touched.has(c.key) ? flagChanged : redraw).push(c.key);
  }
  const remove = [...oldCards.keys()].filter((k) => !nextKeys.has(k));
  return { redraw, flagChanged, add, remove };
}
