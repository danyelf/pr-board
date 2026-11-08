// How often the long-running commands look at GitHub, and how they back off when it fails.
// The watcher and the Mac service both use these, so they behave alike.

export const POLL_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

/** How long to wait after `failures` failed looks in a row (0 failures: the usual wait). */
export function backoff(pollMs: number, failures: number): number {
  return failures > 0 ? Math.min(pollMs * 2 ** failures, MAX_BACKOFF_MS) : pollMs;
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
