import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { makeFactsLoader, makeHandler, type Env, type Handler } from '../src/worker/index.ts';
import { caller } from '../src/worker/access.ts';
import type { Db, ItemRef } from '../src/worker/store.ts';
import type { WorkRecord } from '../src/shared/work.ts';
import { facts } from './view-helpers.ts';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-123';
const EMAIL = 'danyel@gmail.com';
const NOW = new Date('2026-11-06T00:00:00Z');

const CLIENT_ID = 'claude-client.access';
const env: Env = { GITHUB_TOKEN: 'tok', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: EMAIL, SERVICE_CLIENT_ID: CLIENT_ID, DB: {} as Db };

let getKey: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' };
  getKey = createLocalJWKSet({ keys: [jwk] });
});

function sign(over: { email?: string; noEmail?: boolean; commonName?: string; aud?: string; iss?: string } = {}): Promise<string> {
  const claims: Record<string, string> = over.noEmail ? {} : { email: over.email ?? EMAIL };
  if (over.commonName !== undefined) claims.common_name = over.commonName;
  return new SignJWT(claims)
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

function handler() {
  return makeHandler({ getKey, now: () => NOW });
}

async function get(h: Handler, url: string, headers: Record<string, string> = {}, e: Env = env): Promise<Response> {
  return h.fetch(new Request(url, { headers }), e);
}

describe('caller', () => {
  const url = 'https://board.example.com/';
  async function who(over: Parameters<typeof sign>[0] | null, e: Env = env, extra: Record<string, string> = {}, u = url) {
    const headers: Record<string, string> = { ...extra };
    if (over) headers['Cf-Access-Jwt-Assertion'] = await sign(over);
    return caller(new Request(u, { headers }), e, getKey);
  }

  it('is the owner for a token with the owner address', async () => {
    expect(await who({})).toBe('owner');
  });

  it('compares the owner address without regard to capital letters', async () => {
    expect(await who({ email: 'Danyel@GMAIL.com' })).toBe('owner');
  });

  it('is Claude for a service token with the right common name', async () => {
    expect(await who({ noEmail: true, commonName: CLIENT_ID })).toBe('claude');
  });

  it('is nobody for a service token with another common name', async () => {
    expect(await who({ noEmail: true, commonName: 'someone-else.access' })).toBeNull();
  });

  it('never makes Claude of a token with an email, even with the matching common name', async () => {
    expect(await who({ commonName: CLIENT_ID })).toBe('owner');
    expect(await who({ email: 'x@example.com', commonName: CLIENT_ID })).toBeNull();
  });

  it('never makes Claude of anyone when the service client id is empty or missing', async () => {
    const unset = { ...env } as Partial<Env>;
    delete unset.SERVICE_CLIENT_ID;
    for (const e of [unset as Env, { ...env, SERVICE_CLIENT_ID: '' }]) {
      expect(await who({ noEmail: true, commonName: '' }, e)).toBeNull();
      expect(await who({ noEmail: true }, e)).toBeNull();
    }
  });

  it('lets no owner in when no allowed email is set, even a token with no email', async () => {
    const unset = { ...env } as Partial<Env>;
    delete unset.ALLOWED_EMAIL;
    for (const e of [unset as Env, { ...env, ALLOWED_EMAIL: '' }]) {
      expect(await who({ noEmail: true }, e)).toBeNull();
    }
  });

  it('is nobody for no header, the wrong audience, or garbage', async () => {
    expect(await who(null)).toBeNull();
    expect(await who({ aud: 'other' })).toBeNull();
    expect(await caller(new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': 'nonsense' } }), env, getKey)).toBeNull();
  });

  it('on localhost with ALLOW_LOCAL is the owner, or Claude when the local header says so', async () => {
    const local = { ...env, ALLOW_LOCAL: '1' };
    expect(await who(null, local, {}, 'http://localhost:8787/')).toBe('owner');
    expect(await who(null, local, { 'X-Local-Caller': 'claude' }, 'http://localhost:8787/')).toBe('claude');
  });

  it('ignores the local header off localhost, and without ALLOW_LOCAL', async () => {
    expect(await who(null, { ...env, ALLOW_LOCAL: '1' }, { 'X-Local-Caller': 'claude' })).toBeNull();
    expect(await who(null, env, { 'X-Local-Caller': 'claude' }, 'http://localhost:8787/')).toBeNull();
  });
});

describe('worker', () => {
  const POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src https:; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  it('serves a small page shell at /', async () => {
    const res = await get(handler(), 'https://board.example.com/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toBe(POLICY);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const page = await res.text();
    expect(page).toMatch(/<title>[^<]+<\/title>/);
    expect(page).toContain('<link rel="stylesheet" href="/app.css">');
    expect(page).toContain('<script src="/app.js" defer></script>');
    expect(page).toContain('<main id="board">Loading…</main>');
  });

  it('refuses the API with no Access header, with the same headers', async () => {
    const res = await get(handler(), 'https://board.example.com/api/board');
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Security-Policy')).toBe(POLICY);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('refuses the API to someone who is neither the owner nor Claude', async () => {
    const res = await get(handler(), 'https://board.example.com/api/board', { 'Cf-Access-Jwt-Assertion': await sign({ email: 'x@example.com' }) });
    expect(res.status).toBe(403);
  });

  it('passes a signed owner request on to the API', async () => {
    const res = await get(handler(), 'https://board.example.com/api/nope', { 'Cf-Access-Jwt-Assertion': await sign() });
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers an unknown path with 404', async () => {
    expect((await get(handler(), 'https://board.example.com/nope')).status).toBe(404);
  });

  it('answers POST / with 405', async () => {
    const res = await handler().fetch(new Request('https://board.example.com/', { method: 'POST' }), env);
    expect(res.status).toBe(405);
  });
});

describe('the GitHub facts loader', () => {
  function fakeCache() {
    const store = new Map<string, Response>();
    const cache = {
      match: async (req: Request) => store.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => { store.set(req.url, res); },
    } as unknown as Cache;
    return { cache, store };
  }

  function loader(over: { throws?: boolean; cache?: Cache; now?: () => Date } = {}) {
    const asked: { repo: string; numbers: number[] }[][] = [];
    const load = makeFactsLoader({
      fetchFacts: async (_token, want) => {
        asked.push(want);
        if (over.throws) throw new Error('boom');
        return { facts: [facts({ number: 1 })], errors: [] };
      },
      cache: over.cache,
      now: over.now ?? (() => NOW),
    });
    return { load, asked };
  }

  const record = (repo: string, pr: number | null, issue: number | null) => ({ repo, pr, issue }) as WorkRecord;
  const seven: ItemRef = { repo: 'o/r', n: 7 };

  it('reads each record by its PR, or its issue when it has no PR, and the extra items too', async () => {
    const { load, asked } = loader();
    await load(env, [record('o/r', 3, 2), record('o/r', null, 4), record('o/s', 9, null)], false, [seven]);
    expect(asked).toHaveLength(1);
    const byRepo = Object.fromEntries(asked[0]!.map((w) => [w.repo, [...w.numbers].sort((a, b) => a - b)]));
    expect(byRepo).toEqual({ 'o/r': [3, 4, 7], 'o/s': [9] });
  });

  it('reads an extra item that has no record at all', async () => {
    const { load, asked } = loader();
    await load(env, [], false, [seven]);
    expect(asked[0]).toEqual([{ repo: 'o/r', numbers: [7] }]);
  });

  it('says whether the answer came from the cache', async () => {
    const { cache } = fakeCache();
    const { load, asked } = loader({ cache });
    expect((await load(env, [], false, [seven])).fromCache).toBe(false);
    expect((await load(env, [], false, [seven])).fromCache).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it('does not answer from a cached read that lacked an item asked for now', async () => {
    const { cache } = fakeCache();
    const { load, asked } = loader({ cache });
    await load(env, [record('o/r', 3, null)], false, []);
    const again = await load(env, [record('o/r', 3, null)], false, [seven]);
    expect(again.fromCache).toBe(false);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual([{ repo: 'o/r', numbers: [3, 7] }]);
  });

  it('gives the same cached answer however the numbers are ordered', async () => {
    const { cache } = fakeCache();
    const { load, asked } = loader({ cache });
    await load(env, [record('o/r', 3, null), record('o/r', 5, null)], false, []);
    const again = await load(env, [record('o/r', 5, null), record('o/r', 3, null)], false, []);
    expect(again.fromCache).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it('reads afresh when asked to, and does not say it came from the cache', async () => {
    const { cache } = fakeCache();
    const { load, asked } = loader({ cache });
    await load(env, [], false, [seven]);
    const fresh = await load(env, [], true, [seven]);
    expect(fresh.fromCache).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('reads again in the next 60 second slot', async () => {
    const { cache } = fakeCache();
    let at = NOW;
    const { load, asked } = loader({ cache, now: () => at });
    await load(env, [], false, [seven]);
    at = new Date(NOW.getTime() + 61_000);
    await load(env, [], false, [seven]);
    expect(asked).toHaveLength(2);
  });

  it('ignores a cached entry it cannot read', async () => {
    const { cache, store } = fakeCache();
    const { load, asked } = loader({ cache });
    await load(env, [], false, [seven]);
    for (const key of store.keys()) store.set(key, new Response('not json'));
    expect((await load(env, [], false, [seven])).fromCache).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('turns a failure to reach GitHub into an error line, and does not cache it', async () => {
    const { cache, store } = fakeCache();
    const { load } = loader({ cache, throws: true });
    const got = await load(env, [], false, [seven]);
    expect(got.facts).toEqual([]);
    expect(got.errors).toEqual(["Couldn't read GitHub: boom"]);
    expect(store.size).toBe(0);
  });
});
