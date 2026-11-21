// How often the long-running commands ask the board for answers, and how they back off when that fails.
// The watcher and the Mac service both use these, so they behave alike.

export const POLL_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

/** How long to wait after `failures` failed looks in a row (0 failures: the usual wait). */
export function backoff(pollMs: number, failures: number): number {
  return failures > 0 ? Math.min(pollMs * 2 ** failures, MAX_BACKOFF_MS) : pollMs;
}

