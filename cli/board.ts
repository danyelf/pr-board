// The Mac side's way of talking to the board: its /api routes, signed in with a Cloudflare Access service token.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BOARD_URL } from '../src/shared/config.ts';
import { message } from '../src/shared/helpers.ts';
import { Refused } from '../src/shared/work.ts';
import type { Ref } from './gh.ts';

export interface BoardDeps {
  fetch: typeof fetch;
  readFile: (path: string) => string;
  env: NodeJS.ProcessEnv;
  home: string;
}

/** How the commands reach the board when they run for real. */
export function realBoardDeps(): BoardDeps {
  return { fetch, readFile: (p) => readFileSync(p, 'utf8'), env: process.env, home: homedir() };
}

/** The item as the board's routes take it in a body. */
export const where = (ref: Ref) => ({ repo: `${ref.owner}/${ref.repo}`, number: ref.n });

/** The address of the board's record of an item, with its answers. */
export const workPath = (ref: Ref) => `/api/work?repo=${encodeURIComponent(`${ref.owner}/${ref.repo}`)}&number=${ref.n}`;

/** The board couldn't be reached or didn't accept us. The message starts with ⚠️ and says what to do. */
export class BoardError extends Error {
  /** The HTTP status the board answered with, when it answered. */
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

export function tokenFilePath(deps: Pick<BoardDeps, 'env' | 'home'>): string {
  return deps.env.PR_BOARD_ACCESS_FILE || join(deps.home, '.config', 'pr-board', 'access-token.json');
}

function readToken(deps: BoardDeps): { clientId: string; clientSecret: string } {
  const path = tokenFilePath(deps);
  const shape = `{"clientId": "...", "clientSecret": "..."}`;
  let text: string;
  try {
    text = deps.readFile(path);
  } catch {
    throw new BoardError(`⚠️ Couldn't read the board's service token at ${path}. Create that file with the service token's id and secret, as ${shape}, or set PR_BOARD_ACCESS_FILE to where it is.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BoardError(`⚠️ ${path} isn't JSON. It should look like ${shape}.`);
  }
  const t = (parsed ?? {}) as Record<string, unknown>;
  for (const key of ['clientId', 'clientSecret']) {
    if (typeof t[key] !== 'string' || t[key] === '') throw new BoardError(`⚠️ ${path} has no "${key}". It should look like ${shape}.`);
  }
  return { clientId: t.clientId as string, clientSecret: t.clientSecret as string };
}

/**
 * Calls one of the board's routes and returns its JSON. A refusal from the board (409 or 400) is a
 * Refused carrying the board's own words; anything else that goes wrong is a BoardError.
 */
export async function boardCall<T>(deps: BoardDeps, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = readToken(deps);
  const tokenFile = tokenFilePath(deps);
  const url = `${BOARD_URL}${path}`;
  const headers: Record<string, string> = { 'CF-Access-Client-Id': token.clientId, 'CF-Access-Client-Secret': token.clientSecret };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await deps.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  } catch (e) {
    throw new BoardError(`⚠️ Couldn't reach the board at ${url}: ${message(e)}. Check the network and try again; nothing was written.`);
  }

  const refused = `⚠️ The board did not accept the service token in ${tokenFile}. It may have expired or been revoked: make a new one in Cloudflare Access and put it in that file.`;
  if (res.status >= 300 && res.status < 400) throw new BoardError(refused, res.status);
  if ((res.headers.get('Content-Type') ?? '').includes('text/html')) throw new BoardError(refused, res.status);
  if (res.status === 403) throw new BoardError(`⚠️ The board answered 403 to ${url}: the service token in ${tokenFile} isn't accepted as Claude's. Check that the token is the one set up for Claude.`, 403);

  let reply: unknown;
  try {
    reply = await res.json();
  } catch {
    throw new BoardError(`⚠️ The board at ${url} answered ${res.status} with something that isn't JSON. Try again; if it keeps happening, check the board's Worker logs.`, res.status);
  }
  const text = typeof (reply as { error?: unknown } | null)?.error === 'string' ? (reply as { error: string }).error : null;
  if (res.status === 409 || res.status === 400) throw new Refused(text ?? `The board refused ${path} (${res.status})`);
  if (!res.ok) throw new BoardError(`⚠️ The board answered ${res.status} to ${url}${text ? `: ${text}` : ''}. Nothing was written; try again.`, res.status);
  return reply as T;
}
