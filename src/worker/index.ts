import type { JWTVerifyGetKey } from 'jose';
import type { ItemFacts } from '../shared/types.ts';
import { checkAccess, type Env } from './access.ts';
import { buildBoard } from './board.ts';
import { fetchItems } from './github.ts';
import { renderBoard } from './render.ts';

export type { Env } from './access.ts';

interface Deps {
  fetchItems: typeof fetchItems;
  cache?: Cache;
  getKey?: JWTVerifyGetKey;
  now?: () => Date;
}

const CACHE_SECONDS = 60;

// The part of Cloudflare's ExportedHandler this Worker uses, so the tests can type-check without the Workers type definitions.
export interface Handler {
  fetch(req: Request, env: Env): Promise<Response>;
}

export function makeHandler(deps: Deps): Handler {
  const now = deps.now ?? (() => new Date());

  async function load(env: Env, at: Date): Promise<{ items: ItemFacts[]; errors: string[] }> {
    const key = new Request(`https://pr-board.internal/items?minute=${Math.floor(at.getTime() / 60_000)}`);
    const hit = await deps.cache?.match(key);
    if (hit) {
      try {
        const cached = (await hit.json()) as { items?: unknown; errors?: unknown };
        if (Array.isArray(cached.items) && Array.isArray(cached.errors)) return cached as { items: ItemFacts[]; errors: string[] };
      } catch {
        // An entry we can't read is as good as none; fetch fresh.
      }
    }

    let fresh: { items: ItemFacts[]; errors: string[] };
    try {
      fresh = await deps.fetchItems(env.GITHUB_TOKEN, at);
    } catch (e) {
      // A failure to reach GitHub at all is not kept, so the next visit tries again.
      return { items: [], errors: [`Couldn't read GitHub: ${e instanceof Error ? e.message : String(e)}`] };
    }
    // Results with error lines are kept too (errors included), so a partly failing GitHub isn't hit on every refresh.
    if (deps.cache) {
      await deps.cache.put(
        key,
        new Response(JSON.stringify(fresh), { headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` } }),
      );
    }
    return fresh;
  }

  return {
    async fetch(req, env) {
      if (new URL(req.url).pathname !== '/') return new Response('Not found', { status: 404 });
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (!(await checkAccess(req, env, deps.getKey))) return new Response('Not allowed', { status: 403 });

      const at = now();
      const { items, errors } = await load(env, at);
      return new Response(renderBoard(buildBoard(items, errors, at)), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          // The page has only inline styles and images from the web; no scripts, no frames, no other requests.
          'Content-Security-Policy': "default-src 'none'; img-src https:; style-src 'unsafe-inline'",
          'Referrer-Policy': 'no-referrer',
        },
      });
    },
  };
}

export default makeHandler({
  fetchItems,
  cache: typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default,
});
