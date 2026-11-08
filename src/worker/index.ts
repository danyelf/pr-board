import type { JWTVerifyGetKey } from 'jose';
import type { ItemFacts } from '../shared/types.ts';
import { checkAccess, ownerToken, type Env } from './access.ts';
import { buildBoard } from './board.ts';
import { fetchItem, fetchItems, postComment } from './github.ts';
import { ITEM_REF, postAnswer } from './post-answer.ts';
import { renderBoard, renderMessage } from './render.ts';

export type { Env } from './access.ts';

interface Deps {
  fetchItems: typeof fetchItems;
  fetchItem?: typeof fetchItem;
  postComment?: typeof postComment;
  cache?: Cache;
  getKey?: JWTVerifyGetKey;
  now?: () => Date;
}

const CACHE_SECONDS = 60;

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  // The page has only inline styles and images from the web, and its forms post only to itself; no scripts, no frames.
  'Content-Security-Policy': "default-src 'none'; img-src https:; style-src 'unsafe-inline'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
};

// The part of Cloudflare's ExportedHandler this Worker uses, so the tests can type-check without the Workers type definitions.
export interface Handler {
  fetch(req: Request, env: Env): Promise<Response>;
}

/** One cached board per CACHE_SECONDS. */
function cacheKey(at: Date): Request {
  return new Request(`https://pr-board.internal/items?slot=${Math.floor(at.getTime() / (CACHE_SECONDS * 1000))}`);
}

export function makeHandler(deps: Deps): Handler {
  const now = deps.now ?? (() => new Date());

  async function load(env: Env, at: Date, fresh: boolean): Promise<{ items: ItemFacts[]; errors: string[] }> {
    const key = cacheKey(at);
    const hit = fresh ? undefined : await deps.cache?.match(key);
    if (hit) {
      try {
        const cached = (await hit.json()) as { items?: unknown; errors?: unknown };
        if (Array.isArray(cached.items) && Array.isArray(cached.errors)) return cached as { items: ItemFacts[]; errors: string[] };
      } catch {
        // An entry we can't read is as good as none; fetch fresh.
      }
    }

    let result: { items: ItemFacts[]; errors: string[] };
    try {
      result = await deps.fetchItems(env.GITHUB_TOKEN, at);
    } catch (e) {
      // A failure to reach GitHub at all is not kept, so the next visit tries again.
      return { items: [], errors: [`Couldn't read GitHub: ${e instanceof Error ? e.message : String(e)}`] };
    }
    // Results with error lines are kept too (errors included), so a partly failing GitHub isn't hit on every refresh.
    if (deps.cache) {
      await deps.cache.put(
        key,
        new Response(JSON.stringify(result), { headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` } }),
      );
    }
    return result;
  }

  async function answer(req: Request, env: Env): Promise<Response> {
    const result = await postAnswer(req, env, { fetchItem: deps.fetchItem ?? fetchItem, postComment: deps.postComment ?? postComment });
    if ('sent' in result) {
      // The cached board was read before the answer; drop it so the next view shows the item as answered.
      await deps.cache?.delete(cacheKey(now()));
      return new Response(null, { status: 303, headers: { Location: `/?sent=${encodeURIComponent(result.sent)}` } });
    }
    return new Response(renderMessage(result.title, result.text, result.link), { status: result.status, headers: PAGE_HEADERS });
  }

  return {
    async fetch(req, env) {
      const url = new URL(req.url);
      if (url.pathname === '/answer') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        if (!(await checkAccess(req, env, deps.getKey))) return new Response('Not allowed', { status: 403 });
        return answer(req, env);
      }
      if (url.pathname !== '/') return new Response('Not found', { status: 404 });
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (!(await checkAccess(req, env, deps.getKey))) return new Response('Not allowed', { status: 403 });

      const at = now();
      // Straight after sending answers, read GitHub afresh, so the item shows as answered.
      const sentParam = url.searchParams.get('sent');
      const sent = sentParam !== null && ITEM_REF.test(sentParam) ? sentParam : null;
      const { items, errors } = await load(env, at, sent !== null);
      return new Response(renderBoard(buildBoard(items, errors, at), { answering: ownerToken(env) !== null, sent }), { headers: PAGE_HEADERS });
    },
  };
}

export default makeHandler({
  fetchItems,
  cache: typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default,
});
