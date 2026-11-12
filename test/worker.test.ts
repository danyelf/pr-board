import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { makeHandler, type Env, type Handler } from '../src/worker/index.ts';
import { GitHubRefused } from '../src/worker/github.ts';
import { LOOK_DEFAULT, parseAnswer } from '../src/shared/answer.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { parseStatus, renderStatus } from '../src/shared/status.ts';
import type { ItemFacts } from '../src/shared/types.ts';
import { facts, status } from './helpers.ts';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-123';
const EMAIL = 'danyel@gmail.com';
const NOW = new Date('2026-11-06T00:00:00Z');

const env: Env = { GITHUB_TOKEN: 'tok', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: EMAIL };

let getKey: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' };
  getKey = createLocalJWKSet({ keys: [jwk] });
});

function sign(over: { email?: string; noEmail?: boolean; aud?: string; iss?: string } = {}): Promise<string> {
  return new SignJWT(over.noEmail ? {} : { email: over.email ?? EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setAudience(over.aud ?? AUD)
    .setIssuer(over.iss ?? `https://${TEAM}`)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function fakeCache() {
  const store = new Map<string, Response>();
  const puts: string[] = [];
  const cache = {
    match: async (req: Request) => store.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => { puts.push(req.url); store.set(req.url, res); },
  } as unknown as Cache;
  return { cache, puts };
}

function handler(result: { items: ReturnType<typeof facts>[]; errors: string[] }, cache?: Cache) {
  let calls = 0;
  const h = makeHandler({
    fetchItems: async () => { calls++; return result; },
    cache,
    getKey,
    now: () => NOW,
  });
  return { h, calls: () => calls };
}

async function get(h: Handler, url: string, headers: Record<string, string> = {}, e: Env = env): Promise<Response> {
  return h.fetch(new Request(url, { headers }), e);
}

const ok = { items: [facts({ number: 1, labels: ['on sam'] })], errors: [] as string[] };

describe('worker', () => {
  it('refuses a request with no Access header', async () => {
    const res = await get(handler(ok).h, 'https://board.example.com/');
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Not allowed');
  });

  it('serves the board to a correctly signed request', async () => {
    const res = await get(handler(ok).h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': await sign() });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; img-src https:; style-src 'unsafe-inline'; form-action 'self'");
    expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(await res.text()).toContain('#1');
  });

  it('refuses a valid signature for the wrong email', async () => {
    const res = await get(handler(ok).h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': await sign({ email: 'x@example.com' }) });
    expect(res.status).toBe(403);
  });

  it('compares the email without regard to capital letters', async () => {
    const res = await get(handler(ok).h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': await sign({ email: 'Danyel@GMAIL.com' }) });
    expect(res.status).toBe(200);
  });

  it('lets nobody in when no allowed email is set, even a token with no email', async () => {
    const unset = { ...env } as Partial<Env>;
    delete unset.ALLOWED_EMAIL;
    for (const e of [unset as Env, { ...env, ALLOWED_EMAIL: '' }]) {
      const res = await get(handler(ok).h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': await sign({ noEmail: true }) }, e);
      expect(res.status).toBe(403);
    }
  });

  it('refuses the wrong audience', async () => {
    const res = await get(handler(ok).h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': await sign({ aud: 'other' }) });
    expect(res.status).toBe(403);
  });

  it('refuses garbage in the header', async () => {
    const res = await get(handler(ok).h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': 'nonsense' });
    expect(res.status).toBe(403);
  });

  it('lets localhost through when ALLOW_LOCAL is 1', async () => {
    const res = await get(handler(ok).h, 'http://localhost:8787/', {}, { ...env, ALLOW_LOCAL: '1' });
    expect(res.status).toBe(200);
  });

  it('does not let another host through when ALLOW_LOCAL is 1', async () => {
    const res = await get(handler(ok).h, 'https://board.example.com/', {}, { ...env, ALLOW_LOCAL: '1' });
    expect(res.status).toBe(403);
  });

  it('caches a clean fetch and reuses it', async () => {
    const { cache, puts } = fakeCache();
    const { h, calls } = handler(ok, cache);
    const headers = { 'Cf-Access-Jwt-Assertion': await sign() };
    await get(h, 'https://board.example.com/', headers);
    await get(h, 'https://board.example.com/', headers);
    expect(puts).toHaveLength(1);
    expect(calls()).toBe(1);
  });

  it('caches a fetch that had errors too, and shows the errors from the cached copy', async () => {
    const { cache, puts } = fakeCache();
    const { h, calls } = handler({ items: ok.items, errors: ['bad'] }, cache);
    const headers = { 'Cf-Access-Jwt-Assertion': await sign() };
    const first = await get(h, 'https://board.example.com/', headers);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('bad');
    expect(puts).toHaveLength(1);
    const second = await get(h, 'https://board.example.com/', headers);
    expect(await second.text()).toContain('bad');
    expect(calls()).toBe(1);
  });

  it('ignores a cached entry it cannot read and fetches fresh', async () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (req: Request) => store.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => { store.set(req.url, res); },
    } as unknown as Cache;
    const { h, calls } = handler(ok, cache);
    const headers = { 'Cf-Access-Jwt-Assertion': await sign() };
    await get(h, 'https://board.example.com/', headers);
    for (const key of store.keys()) store.set(key, new Response('not json'));
    const res = await get(h, 'https://board.example.com/', headers);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('#1');
    expect(calls()).toBe(2);
  });

  it('shows an error line, not a bare 500, when reading GitHub throws, and does not cache it', async () => {
    const { cache, puts } = fakeCache();
    const h = makeHandler({ fetchItems: async () => { throw new Error('Unterminated string'); }, cache, getKey, now: () => NOW });
    const res = await get(h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': await sign() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Couldn&#39;t read GitHub: Unterminated string');
    expect(puts).toHaveLength(0);
  });

  it('answers other paths with 404', async () => {
    const res = await get(handler(ok).h, 'http://localhost:8787/nope', {}, { ...env, ALLOW_LOCAL: '1' });
    expect(res.status).toBe(404);
  });
});

describe('POST /answer', () => {
  const ORIGIN = 'http://localhost:8787';
  const answerEnv: Env = { ...env, ALLOW_LOCAL: '1' };
  const asking = status({ waitingOn: 'owner', questions: [{ n: 1, text: 'Colour?', choices: ['leave', 'change'], defaultChoice: 'leave' }] });
  const item = () => facts({ repo: 'acme/x', number: 5, labels: ['on sam'], body: renderStatus(asking) });
  const good = { repo: 'acme/x', number: '5', fingerprint: statusFingerprint(asking), q1: 'change', look: LOOK_DEFAULT, note: 'tint is strong' };

  function answerHandler(over: { item?: ItemFacts | null; readFails?: boolean; postFails?: number; postedAs?: string } = {}) {
    const posted: { token: string; repo: string; n: number; body: string }[] = [];
    const read: { token: string; repo: string; n: number }[] = [];
    const store = new Map<string, Response>();
    const cache = {
      match: async (req: Request) => store.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => { store.set(req.url, res); },
      delete: async (req: Request) => store.delete(req.url),
    } as unknown as Cache;
    let fetches = 0;
    const h = makeHandler({
      fetchItems: async () => { fetches++; return ok; },
      fetchItem: async (token, repo, n) => {
        read.push({ token, repo, n });
        if (over.readFails) throw new Error('GitHub said 502 Bad Gateway');
        return over.item === undefined ? item() : over.item;
      },
      postComment: async (token, repo, n, body) => {
        if (over.postFails) throw new GitHubRefused(over.postFails, over.postFails === 403 ? 'Forbidden' : 'Internal Server Error');
        posted.push({ token, repo, n, body });
        return { login: over.postedAs ?? 'sam-gh' };
      },
      cache, getKey, now: () => NOW,
    });
    return { h, posted, read, store, fetches: () => fetches };
  }

  function post(h: Handler, fields: Record<string, string> | string, over: { headers?: Record<string, string>; url?: string; e?: Env } = {}) {
    const body = typeof fields === 'string' ? fields : new URLSearchParams(fields).toString();
    return h.fetch(new Request(over.url ?? `${ORIGIN}/answer`, {
      method: 'POST', body,
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', ...over.headers },
    }), over.e ?? answerEnv);
  }

  it('posts the answers with the board token, then sends the browser back to the board', async () => {
    const { h, posted, read } = answerHandler();
    const res = await post(h, good);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?sent=acme%2Fx%235');
    expect(read).toEqual([{ token: 'tok', repo: 'acme/x', n: 5 }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.token).toBe('tok');
    expect(posted[0]!).toMatchObject({ repo: 'acme/x', n: 5 });
    expect(parseAnswer(posted[0]!.body)).toEqual({ fingerprint: good.fingerprint, answers: { '1': 'change', look: LOOK_DEFAULT }, note: 'tint is strong' });
    expect(posted[0]!.body).toContain('1. Colour? → **change**');
  });

  it('drops the cached board, and the page after the post reads GitHub afresh and says what was sent', async () => {
    const { h, store, fetches } = answerHandler();
    await h.fetch(new Request(`${ORIGIN}/`), answerEnv);
    expect(store.size).toBe(1);
    await post(h, good);
    expect(store.size).toBe(0);
    await h.fetch(new Request(`${ORIGIN}/`), answerEnv);
    const after = await h.fetch(new Request(`${ORIGIN}/?sent=${encodeURIComponent('acme/x#5')}`), answerEnv);
    expect(await after.text()).toContain('Sent your answers on acme/x#5.');
    expect(fetches()).toBe(3);
  });

  it('ignores a sent value that is not an item reference', async () => {
    const { h } = answerHandler();
    const res = await h.fetch(new Request(`${ORIGIN}/?sent=${encodeURIComponent('<b>hi</b>')}`), answerEnv);
    expect(await res.text()).not.toContain('Sent your answers');
  });

  it('refuses a post from another origin, or with none', async () => {
    const { h, posted } = answerHandler();
    expect((await post(h, good, { headers: { Origin: 'https://evil.example.com' } })).status).toBe(403);
    const noOrigin = new Request(`${ORIGIN}/answer`, { method: 'POST', body: new URLSearchParams(good).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect((await h.fetch(noOrigin, answerEnv)).status).toBe(403);
    expect(posted).toHaveLength(0);
  });

  it('is behind the Access check', async () => {
    const { h, posted } = answerHandler();
    const res = await post(h, good, { url: 'https://board.example.com/answer', headers: { Origin: 'https://board.example.com' } });
    expect(res.status).toBe(403);
    expect(posted).toHaveLength(0);
  });

  it('takes only form posts, and only POST', async () => {
    const { h, posted } = answerHandler();
    expect((await post(h, JSON.stringify(good), { headers: { 'Content-Type': 'application/json' } })).status).toBe(415);
    expect((await h.fetch(new Request(`${ORIGIN}/answer`), answerEnv)).status).toBe(405);
    expect(posted).toHaveLength(0);
  });

  it('takes a body up to 32 KB, and refuses one that says it is longer without reading it', async () => {
    // A 20 KB note gets past the size limit and is turned down by the note check instead.
    expect((await post(answerHandler().h, { ...good, note: 'x'.repeat(20 * 1024) })).status).toBe(400);
    const { h, posted, read } = answerHandler();
    const res = await post(h, good, { headers: { 'Content-Length': String(33 * 1024) } });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('more than 32 KB');
    expect(read).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('stops reading a streamed body with no length given as soon as it passes 32 KB', async () => {
    const { h, posted, read } = answerHandler();
    const chunk = new TextEncoder().encode(`note=${'x'.repeat(1024)}`);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request(`${ORIGIN}/answer`, {
      method: 'POST', body, duplex: 'half',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    } as RequestInit);
    expect(req.headers.get('Content-Length')).toBeNull();
    const res = await h.fetch(req, answerEnv);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(40);
    expect(read).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('refuses a bad repo, number or fingerprint, an unknown field, or a field given twice', async () => {
    const { h, posted, read } = answerHandler();
    for (const fields of [
      { ...good, repo: 'acme/x/../y' }, { ...good, repo: '' }, { ...good, number: '5a' }, { ...good, number: '0' },
      { ...good, fingerprint: 'nope' }, { ...good, extra: '1' },
    ]) {
      expect((await post(h, fields)).status).toBe(400);
    }
    expect((await post(h, `${new URLSearchParams(good)}&q1=leave`)).status).toBe(400);
    expect(read).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it("refuses a choice that isn't listed, and says why", async () => {
    const { h, posted } = answerHandler();
    const res = await post(h, { ...good, q1: 'purple' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('&quot;purple&quot; isn&#39;t one of the choices for question 1');
    expect(posted).toHaveLength(0);
  });

  it('refuses, and sends nothing, when the questions changed since the page was loaded', async () => {
    const changed = facts({ repo: 'acme/x', number: 5, labels: ['on sam'], body: renderStatus({ ...asking, ask: 'something else' }) });
    const { h, posted } = answerHandler({ item: changed });
    const res = await post(h, good);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('changed since this page was loaded');
    expect(posted).toHaveLength(0);
  });

  it('checks a status edited by hand against its text, the way the page showed it', async () => {
    const body = renderStatus(asking).replace('1. Colour?', '1. Colour of the button?');
    const shown = parseStatus(body)!;
    expect(shown.editedByHand).toBe(true);
    const edited = facts({ repo: 'acme/x', number: 5, labels: ['on sam'], body });
    const { h, posted } = answerHandler({ item: edited });
    expect((await post(h, good)).status).toBe(409);
    expect((await post(h, { ...good, fingerprint: statusFingerprint(shown) })).status).toBe(303);
    expect(posted[0]!.body).toContain('1. Colour of the button? → **change**');
  });

  it('refuses a second answer while the first is still waiting on the status, with a link to the first', async () => {
    const answers = [{ id: 'IC_1', url: 'https://github.com/acme/x/pull/5#issuecomment-1', at: '2026-11-05T23:00:00Z', claimedAt: null }];
    const { h, posted } = answerHandler({ item: { ...item(), answers } });
    const res = await post(h, good);
    expect(res.status).toBe(409);
    const page = await res.text();
    expect(page).toContain('already answered acme/x#5');
    expect(page).toContain('href="https://github.com/acme/x/pull/5#issuecomment-1">Your answers ↗</a>');
    expect(posted).toHaveLength(0);
  });

  it("refuses answers from a page left open after the item stopped being the owner's turn", async () => {
    const moved = facts({ repo: 'acme/x', number: 5, labels: ['in-progress'], body: renderStatus({ ...asking, waitingOn: 'claude' }) });
    const { h, posted } = answerHandler({ item: moved });
    const res = await post(h, good);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('isn&#39;t waiting on you any more');
    expect(posted).toHaveLength(0);
  });

  it("refuses an item the read token can't see, or one that is closed", async () => {
    const hidden = answerHandler({ item: null });
    expect((await post(hidden.h, good)).status).toBe(404);
    const closed = answerHandler({ item: { ...item(), closedAt: '2026-11-05T00:00:00Z' } });
    expect((await post(closed.h, good)).status).toBe(409);
    expect([...hidden.posted, ...closed.posted]).toHaveLength(0);
  });

  it('says the token needs write access when GitHub forbids the comment', async () => {
    const res = await post(answerHandler({ postFails: 403 }).h, good);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('needs read and write access to Issues and Pull requests');
  });

  it('says so when GitHub could not be read or failed to take the comment', async () => {
    expect((await post(answerHandler({ readFails: true }).h, good)).status).toBe(502);
    const failed = await post(answerHandler({ postFails: 500 }).h, good);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain('GitHub said 500 Internal Server Error');
  });

  it('warns when the comment went up under another account, since the watcher would not read it', async () => {
    const res = await post(answerHandler({ postedAs: 'someone-else' }).h, good);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('someone-else');
  });
});
