// The settings that name the person this board is for. The tests swap in a different file
// (see vitest.config.ts), so nothing else in the code can assume who that is.
import config from '../../pr-board.config.json' with { type: 'json' };

function ownerName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('pr-board.config.json needs "ownerName": the name of the person the board is for');
  }
  return value.trim();
}

/** The person whose PRs and issues these are, as the status section and the labels spell them. */
export const OWNER_NAME = ownerName((config as { ownerName?: unknown }).ownerName);
