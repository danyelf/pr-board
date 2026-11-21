// How often the long-running commands ask the board for answers, and how they back off when that fails.
// The watcher and the Mac service both use these, so they behave alike.

export const POLL_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

/** How long to wait after `failures` failed looks in a row (0 failures: the usual wait). */
export function backoff(pollMs: number, failures: number): number {
  return failures > 0 ? Math.min(pollMs * 2 ** failures, MAX_BACKOFF_MS) : pollMs;
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How many GitHub reads run at once: each `gh` call takes about 0.3 s, so reading items one at a time adds up. */
export const PARALLEL_READS = 6;

/** Runs `fn` on every item, at most `limit` at a time, and returns the results in the items' order. */
export async function inParallel<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
