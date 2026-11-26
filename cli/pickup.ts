// Picking up an issue from the backlog: a row on the board, where it waits for a free session, then the in-progress
// label on GitHub. Both the Mac service (carrying out a proposal's answers) and `pr-status pick-up` do it this way.
import { LABEL_IN_PROGRESS } from '../src/shared/names.ts';
import { message } from '../src/shared/helpers.ts';
import { boardCall, where, type BoardDeps } from './board.ts';
import type { Gh, Ref } from './gh.ts';

/** The row comes first, so a pick-up the board refuses leaves no label behind on an issue nobody will start. */
export async function pickUp(gh: Gh, board: BoardDeps, ref: Ref, proposalId: number | null): Promise<void> {
  await boardCall(board, 'POST', '/api/pickup-add', { ...where(ref), proposalId });
  try {
    await gh(['issue', 'edit', String(ref.n), '-R', `${ref.owner}/${ref.repo}`, '--add-label', LABEL_IN_PROGRESS]);
  } catch (e) {
    throw new Error(`it is picked up on the board, but the ${LABEL_IN_PROGRESS} label couldn't be added: ${message(e)}`, { cause: e });
  }
}

/** The comment an issue closed from a proposal gets. */
export function closeComment(reason: string): string {
  return `${reason}\n\nClosed from a backlog proposal on PR Board.`;
}
