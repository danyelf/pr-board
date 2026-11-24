import { describe, expect, it } from 'vitest';
import { main } from '../cli/setup-labels.ts';

const NOW = new Date('2026-11-20T22:00:00Z');

function world(existing: string[]) {
  const created: string[] = [];
  const gh = async (args: string[]): Promise<string> => {
    const path = args[1] ?? '';
    if (path.startsWith('user/repos')) return JSON.stringify([[{ full_name: 'acme/x', pushed_at: '2026-11-19T00:00:00Z' }]]);
    if (path.endsWith('/labels?per_page=100')) return JSON.stringify([existing.map((name) => ({ name }))]);
    if (args.includes('POST')) { created.push(args.find((a) => a.startsWith('name='))!.slice(5)); return '{}'; }
    return '{}';
  };
  return { gh, created };
}

describe('setup-labels', () => {
  it('creates the six labels the board writes, and in-progress', async () => {
    const w = world([]);
    expect(await main([], { gh: w.gh, now: () => NOW, out: () => {}, err: () => {} })).toBe(0);
    expect(w.created).toEqual(['gate: design', 'gate: implementation', 'gate: prep', 'on sam', 'ready to merge', 'parked', 'in-progress']);
  });

  it('creates only the ones a repo is missing', async () => {
    const w = world(['parked', 'in-progress', 'gate: prep']);
    await main([], { gh: w.gh, now: () => NOW, out: () => {}, err: () => {} });
    expect(w.created).toEqual(['gate: design', 'gate: implementation', 'on sam', 'ready to merge']);
  });
});
