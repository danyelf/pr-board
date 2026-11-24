import { describe, expect, it } from 'vitest';
import { BoardError, boardCall, type BoardDeps } from '../cli/board.ts';
import { Refused } from '../src/shared/work.ts';

const TOKEN = JSON.stringify({ clientId: 'id-1', clientSecret: 'secret-1' });

interface Seen { url: string; init: RequestInit }

function deps(reply: () => Response | Promise<Response>, over: Partial<BoardDeps> = {}) {
  const seen: Seen[] = [];
  const read: string[] = [];
  const d: BoardDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return reply();
    }) as typeof fetch,
    readFile: (p) => { read.push(p); return TOKEN; },
    env: {},
    home: '/home/test',
    ...over,
  };
  return { d, seen, read };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('boardCall', () => {
  it('sends both Access headers and the JSON body, and returns the reply', async () => {
    const { d, seen, read } = deps(() => json({ ok: 1 }));
    const got = await boardCall<{ ok: number }>(d, 'POST', '/api/ok', { repo: 'a/b', number: 5 });
    expect(got).toEqual({ ok: 1 });
    expect(seen[0]!.url).toBe('https://board.example.test/api/ok');
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get('CF-Access-Client-Id')).toBe('id-1');
    expect(headers.get('CF-Access-Client-Secret')).toBe('secret-1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(seen[0]!.init.body).toBe(JSON.stringify({ repo: 'a/b', number: 5 }));
    expect(read).toEqual(['/home/test/.config/pr-board/access-token.json']);
  });

  it('reads the token from $PR_BOARD_ACCESS_FILE when set', async () => {
    const { d, read } = deps(() => json({}), { env: { PR_BOARD_ACCESS_FILE: '/elsewhere/token.json' } });
    await boardCall(d, 'GET', '/api/work?repo=a%2Fb&number=5');
    expect(read).toEqual(['/elsewhere/token.json']);
  });

  it('says the service token was refused when Access answers with HTML', async () => {
    for (const reply of [
      () => new Response('<html>Sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      () => new Response(null, { status: 302, headers: { Location: 'https://team.cloudflareaccess.com/login' } }),
    ]) {
      const { d } = deps(reply);
      const err = await boardCall(d, 'GET', '/api/work').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BoardError);
      expect((err as Error).message).toMatch(/^⚠️ /);
      expect((err as Error).message).toContain('/home/test/.config/pr-board/access-token.json');
    }
  });

  it('says the token file when the board answers 403', async () => {
    const { d } = deps(() => json({ error: 'This is for Claude' }, 403));
    const err = await boardCall(d, 'POST', '/api/ok', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardError);
    expect((err as Error).message).toContain('access-token.json');
  });

  it('says how to create a missing token file', async () => {
    const { d } = deps(() => json({}), { readFile: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); } });
    const err = await boardCall(d, 'GET', '/api/work').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardError);
    const message = (err as Error).message;
    expect(message).toMatch(/^⚠️ /);
    expect(message).toContain('/home/test/.config/pr-board/access-token.json');
    expect(message).toContain('clientId');
    expect(message).toContain('clientSecret');
  });

  it('complains about a token file that is not the right JSON', async () => {
    const { d } = deps(() => json({}), { readFile: () => '{"clientId":"x"}' });
    const err = await boardCall(d, 'GET', '/api/work').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardError);
    expect((err as Error).message).toContain('clientSecret');
  });

  it('names the URL when the network fails', async () => {
    const { d } = deps(() => { throw new TypeError('fetch failed'); });
    const err = await boardCall(d, 'POST', '/api/ok', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardError);
    expect((err as Error).message).toMatch(/^⚠️ /);
    expect((err as Error).message).toContain('https://board.example.test/api/ok');
  });

  it('throws Refused with the board\'s text on 409 and 400', async () => {
    for (const status of [409, 400]) {
      const { d } = deps(() => json({ error: 'Nope, because.' }, status));
      const err = await boardCall(d, 'POST', '/api/status', {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Refused);
      expect(err).not.toBeInstanceOf(BoardError);
      expect((err as Error).message).toBe('Nope, because.');
    }
  });

  it('throws a BoardError for other failures, with the board\'s text', async () => {
    const { d } = deps(() => json({ error: 'Couldn\'t read it from GitHub' }, 502));
    const err = await boardCall(d, 'POST', '/api/status', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardError);
    expect((err as Error).message).toMatch(/^⚠️ .*502.*Couldn't read it from GitHub/);
  });
});
