import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { makeHandler, type Env, type Handler } from '../src/worker/index.ts';
import { facts } from './helpers.ts';

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

function sign(over: { email?: string; aud?: string; iss?: string } = {}): Promise<string> {
  return new SignJWT({ email: over.email ?? EMAIL })
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

const ok = { items: [facts({ number: 1, labels: ['on danyel'] })], errors: [] as string[] };

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
    expect(await res.text()).toContain('#1');
  });

  it('refuses a valid signature for the wrong email', async () => {
    const res = await get(handler(ok).h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': await sign({ email: 'x@example.com' }) });
    expect(res.status).toBe(403);
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

  it('does not cache a fetch that had errors', async () => {
    const { cache, puts } = fakeCache();
    const { h } = handler({ items: ok.items, errors: ['bad'] }, cache);
    const res = await get(h, 'https://board.example.com/', { 'Cf-Access-Jwt-Assertion': await sign() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('bad');
    expect(puts).toHaveLength(0);
  });

  it('answers other paths with 404', async () => {
    const res = await get(handler(ok).h, 'http://localhost:8787/nope', {}, { ...env, ALLOW_LOCAL: '1' });
    expect(res.status).toBe(404);
  });
});
