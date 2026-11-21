import type { JWTVerifyGetKey } from 'jose';
import type { Facts } from '../shared/facts.ts';
import { caller, type Env } from './access.ts';
import { handleApi, type ApiDeps, type FactsResult } from './api.ts';
import { fetchFacts, setLabels } from './github.ts';
import type { ItemRef } from './store.ts';

export type { Env } from './access.ts';

const CACHE_SECONDS = 60;

// Scripts and styles only from the Worker's own address, requests only back to it, images from the web (screenshots), nothing framed.
const POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src https:; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PR Board</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<main id="board">Loading…</main>
</body>
</html>
`;

function withHeaders(res: Response, contentType?: string): Response {
  const headers = new Headers(res.headers);
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('Content-Security-Policy', POLICY);
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, { status: res.status, headers });
}

// The part of the Workers execution context this Worker uses.
interface Context { waitUntil(p: Promise<unknown>): void }

// The part of Cloudflare's ExportedHandler this Worker uses, so the tests can type-check without the Workers type definitions.
export interface Handler {
  fetch(req: Request, env: Env, ctx?: Context): Promise<Response>;
}

interface FactsDeps {
  fetchFacts: typeof fetchFacts;
  cache?: Cache;
  now: () => Date;
}

/** What to read from GitHub: for each repo, the numbers of the records' items and of the extra items. */
function wanted(records: { repo: string; pr: number | null; issue: number | null }[], extra: ItemRef[]): { repo: string; numbers: number[] }[] {
  const byRepo = new Map<string, Set<number>>();
  const add = (repo: string, n: number) => byRepo.set(repo, (byRepo.get(repo) ?? new Set<number>()).add(n));
  for (const r of records) {
    const n = r.pr ?? r.issue;
    if (n !== null) add(r.repo, n);
  }
  for (const e of extra) add(e.repo, e.n);
  return [...byRepo].map(([repo, set]) => ({ repo, numbers: [...set].sort((a, b) => a - b) }));
}

/** One cached read per CACHE_SECONDS for each set of numbers asked for. */
function cacheKey(want: { repo: string; numbers: number[] }[], at: Date): Request {
  const slot = Math.floor(at.getTime() / (CACHE_SECONDS * 1000));
  const asked = want.map((w) => `${w.repo}#${w.numbers.join(',')}`).sort().join(' ');
  return new Request(`https://pr-board.internal/facts?slot=${slot}&asked=${encodeURIComponent(asked)}`);
}

/** Reads the facts from GitHub, keeping the answer for CACHE_SECONDS unless a fresh read is asked for. */
export function makeFactsLoader(deps: FactsDeps): ApiDeps['facts'] {
  return async (env, records, fresh, extra): Promise<FactsResult> => {
    const want = wanted(records, extra);
    const key = cacheKey(want, deps.now());
    const hit = fresh ? undefined : await deps.cache?.match(key);
    if (hit) {
      try {
        const cached = (await hit.json()) as { facts?: unknown; errors?: unknown };
        if (Array.isArray(cached.facts) && Array.isArray(cached.errors)) {
          return { facts: cached.facts as Facts[], errors: cached.errors as string[], fromCache: true };
        }
      } catch {
        // An entry we can't read is as good as none; read fresh.
      }
    }
    let result: { facts: Facts[]; errors: string[] };
    try {
      result = await deps.fetchFacts(env.GITHUB_TOKEN, want, deps.now());
    } catch (e) {
      // A failure to reach GitHub at all is not kept, so the next request tries again.
      return { facts: [], errors: [`Couldn't read GitHub: ${e instanceof Error ? e.message : String(e)}`], fromCache: false };
    }
    // A read with error lines is kept too, so a partly failing GitHub isn't hit on every refresh.
    await deps.cache?.put(key, new Response(JSON.stringify(result), { headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` } }));
    return { ...result, fromCache: false };
  };
}

interface Deps {
  fetchFacts?: typeof fetchFacts;
  setLabels?: typeof setLabels;
  cache?: Cache;
  getKey?: JWTVerifyGetKey;
  now?: () => Date;
}

export function makeHandler(deps: Deps = {}): Handler {
  const now = deps.now ?? (() => new Date());
  const loadFacts = makeFactsLoader({ fetchFacts: deps.fetchFacts ?? fetchFacts, cache: deps.cache, now });

  return {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      if (url.pathname === '/') {
        if (req.method !== 'GET') return withHeaders(new Response('Method not allowed', { status: 405 }));
        // The shell holds no data; the board itself is read through the API.
        return withHeaders(new Response(SHELL), 'text/html; charset=utf-8');
      }
      if (url.pathname.startsWith('/api/')) {
        const who = await caller(req, env, deps.getKey);
        if (!who) return withHeaders(new Response('Not allowed', { status: 403 }));
        const apiDeps: ApiDeps = {
          now,
          facts: loadFacts,
          setLabels: deps.setLabels ?? setLabels,
          waitUntil: (p) => ctx?.waitUntil(p),
        };
        return withHeaders(await handleApi(req, env, who, apiDeps));
      }
      return withHeaders(new Response('Not found', { status: 404 }));
    },
  };
}

export default makeHandler({
  cache: typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default,
});
