import { describe, expect, it } from 'vitest';
import { isNotFound } from '../cli/gh.ts';
import { inParallel } from '../cli/poll.ts';

describe('inParallel', () => {
  it('runs at most the limit at once and keeps the results in order', async () => {
    let running = 0;
    let most = 0;
    const results = await inParallel([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(most).toBe(3);
  });

  it('returns nothing for nothing', async () => {
    expect(await inParallel([], 6, async () => 1)).toEqual([]);
  });
});

describe('isNotFound', () => {
  it('reads what GitHub said, not the request, which may name item #404', () => {
    expect(isNotFound(new Error('gh api repos/acme/x/issues/404 failed: HTTP 502 Bad Gateway'))).toBe(false);
    expect(isNotFound(new Error('gh api repos/acme/x/issues/7 failed: gh: Not Found (HTTP 404)'))).toBe(true);
    expect(isNotFound(new Error('gh: HTTP 404'))).toBe(true);
  });
});
