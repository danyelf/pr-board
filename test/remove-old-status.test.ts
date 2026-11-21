import { describe, expect, it } from 'vitest';
import type { Gh } from '../cli/gh.ts';
import { main, withoutStatus } from '../cli/remove-old-status.ts';

const OLD_BLOCK = [
  '<!-- status -->',
  '**Waiting on:** Sam, since 2026-11-04T09:00:00-08:00',
  '**Ask:** look',
  '<!-- data: {"v":1} -->',
  '<!-- /status -->',
].join('\n');

interface Item { number: number; body: string | null; pull_request?: unknown }
interface Comment { id: number; body: string; user: { login: string } }

/** GitHub as the clean-up sees it: open items per repo, their comments, and every write it is asked to make. */
function world(opts: { login?: string; items: Item[]; comments?: Record<number, Comment[]> }) {
  const writes: string[][] = [];
  const gh: Gh = async (args) => {
    const path = args.find((a) => a.startsWith('repos/') || a === 'user') ?? '';
    if (args.includes('PATCH') || args.includes('DELETE')) {
      writes.push(args);
      return '{}';
    }
    if (path === 'user') return `${opts.login ?? 'claude-bot'}\n`;
    if (/^repos\/acme\/x\/issues\?state=open/.test(path)) return JSON.stringify([opts.items]);
    const comments = /^repos\/acme\/x\/issues\/(\d+)\/comments/.exec(path);
    if (comments) return JSON.stringify([opts.comments?.[Number(comments[1])] ?? []]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, writes };
}

async function run(w: ReturnType<typeof world>, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { gh: w.gh, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe('withoutStatus', () => {
  it('removes the block and keeps the rest of the description', () => {
    expect(withoutStatus(`${OLD_BLOCK}\n\n## Summary\nDoes a thing.\n`)).toBe('## Summary\nDoes a thing.\n');
  });

  it('removes a block in the middle without leaving a gap', () => {
    expect(withoutStatus(`Intro\n\n${OLD_BLOCK}\n\nRest`)).toBe('Intro\n\nRest');
  });

  it('returns null when there is no block', () => {
    expect(withoutStatus('Just a description')).toBeNull();
    expect(withoutStatus('<!-- status --> but never closed')).toBeNull();
  });
});

describe('remove-old-status', () => {
  it('rewrites a PR description without its status block, and prints the change', async () => {
    const w = world({ items: [
      { number: 5, body: `${OLD_BLOCK}\n\nCloses #4\n\nThe rest.`, pull_request: {} },
      { number: 6, body: 'No status here', pull_request: {} },
    ] });
    const r = await run(w, ['acme/x']);
    expect(r.code).toBe(0);
    expect(w.writes).toEqual([['api', '-X', 'PATCH', 'repos/acme/x/pulls/5', '-f', 'body=Closes #4\n\nThe rest.']]);
    expect(r.out).toEqual(['acme/x#5: removed the status section from the description']);
  });

  it("deletes this account's status comments on an issue, and never the owner's", async () => {
    const w = world({
      items: [{ number: 7, body: 'An issue' }],
      comments: { 7: [
        { id: 70, body: `${OLD_BLOCK}`, user: { login: 'claude-bot' } },
        { id: 71, body: `${OLD_BLOCK}`, user: { login: 'sam-gh' } },
        { id: 72, body: 'A normal comment', user: { login: 'claude-bot' } },
        { id: 73, body: `Mentions ${OLD_BLOCK} later on`, user: { login: 'claude-bot' } },
      ] },
    });
    const r = await run(w, ['acme/x']);
    expect(r.code).toBe(0);
    expect(w.writes).toEqual([['api', '-X', 'DELETE', 'repos/acme/x/issues/comments/70']]);
    expect(r.out).toContain('acme/x#7: deleted status comment 70');
    expect(r.out).toContain('acme/x#7: left status comment 71 alone, since sam-gh wrote it');
  });

  it('makes no change with --dry-run, and says what it would do', async () => {
    const w = world({
      items: [{ number: 5, body: `${OLD_BLOCK}\n\nBody`, pull_request: {} }, { number: 7, body: 'An issue' }],
      comments: { 7: [{ id: 70, body: OLD_BLOCK, user: { login: 'claude-bot' } }] },
    });
    const r = await run(w, ['--dry-run', 'acme/x']);
    expect(r.code).toBe(0);
    expect(w.writes).toEqual([]);
    expect(r.out).toEqual([
      'acme/x#5: would remove the status section from the description',
      'acme/x#7: would delete status comment 70',
    ]);
  });

  it("refuses to run as the owner's account", async () => {
    const w = world({ login: 'sam-gh', items: [{ number: 5, body: OLD_BLOCK, pull_request: {} }] });
    const r = await run(w, ['acme/x']);
    expect(r.code).toBe(1);
    expect(w.writes).toEqual([]);
    expect(r.err.join('\n')).toContain("gh is signed in as sam-gh, the board's owner");
  });

  it('needs at least one repo, written owner/repo', async () => {
    const w = world({ items: [] });
    expect((await run(w, [])).code).toBe(1);
    expect((await run(w, ['acme'])).code).toBe(1);
    expect(w.writes).toEqual([]);
  });
});
