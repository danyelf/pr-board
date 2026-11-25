// Picking up an issue from the backlog: the in-progress label on GitHub, then a row on the board, where it waits for
// a free session. Both the Mac service (carrying out a proposal's answers) and `pr-status pick-up` do it this way.
import { LABEL_IN_PROGRESS } from '../src/shared/names.ts';
import { boardCall, where, type BoardDeps } from './board.ts';
import type { Gh, Ref } from './gh.ts';

export async function pickUp(gh: Gh, board: BoardDeps, ref: Ref, proposalId: number | null): Promise<void> {
  await gh(['issue', 'edit', String(ref.n), '-R', `${ref.owner}/${ref.repo}`, '--add-label', LABEL_IN_PROGRESS]);
  await boardCall(board, 'POST', '/api/pickup-add', { ...where(ref), proposalId });
}

/** The comment an issue closed from a proposal gets. */
export function closeComment(reason: string): string {
  return `${reason}\n\nClosed from a backlog proposal on PR Board.`;
}
