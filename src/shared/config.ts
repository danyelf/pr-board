// The tests swap in a different file (see vitest.config.ts).
import config from '../../pr-board.config.json' with { type: 'json' };

function setting(key: 'ownerName' | 'ownerLogin' | 'boardUrl', meaning: string): string {
  const value: unknown = (config as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`pr-board.config.json needs "${key}": ${meaning}`);
  return value.trim();
}

/** The person the board is for, as the labels and the Mac service's messages spell them. */
export const OWNER_NAME = setting('ownerName', 'the name of the person the board is for');

/** That person's GitHub login: the one asked to review a PR handed to them. */
export const OWNER_LOGIN = setting('ownerLogin', "that person's GitHub login");

/** Where the board runs, with no trailing slash: the Mac side calls its /api routes. */
export const BOARD_URL = setting('boardUrl', 'the address of the board, such as https://pr-board.example.com').replace(/\/+$/, '');
