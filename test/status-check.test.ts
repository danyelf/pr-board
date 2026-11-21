import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../hooks/status-check.ts';
import type { Gh } from '../cli/gh.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'transcripts');

interface Setup {
  /** What the board has on record for every item: null means no record (404). */
  record?: { writtenAt?: string; confirmedAt?: string | null } | null;
  boardDown?: boolean;
  throwOn?: string;
  headPrs?: number[];
  branch?: string;
}

function fake(setup: Setup = {}) {
  const asked: string[] = [];
  const gh: Gh = async (args, opts) => {
    const line = args.join(' ');
    if (setup.throwOn && line.includes(setup.throwOn)) throw new Error('boom');
    if (args[0] === 'repo' && args[1] === 'view') {
      return opts?.cwd?.endsWith('torahmap') ? 'danyelf/torahmap\n' : 'other/repo\n';
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify((setup.headPrs ?? []).map((number) => ({ number })));
    if (args[0] === 'pr' && args[1] === 'view') return '574\n';
    throw new Error(`unexpected gh call: ${line}`);
  };
  const git: Gh = async () => `${setup.branch ?? 'feature-x'}\n`;
  const fakeFetch = (async (url: string) => {
    asked.push(String(url));
    if (setup.boardDown) throw new Error('network down');
    if (setup.record === null || setup.record === undefined) {
      return new Response(JSON.stringify({ error: 'no record' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    const record = { writtenAt: '2026-11-05T09:00:00Z', confirmedAt: null, ...setup.record };
    return new Response(JSON.stringify({ record, answers: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const board = {
    fetch: fakeFetch,
    readFile: () => JSON.stringify({ clientId: 'id', clientSecret: 'secret' }),
    env: {},
    home: '/home',
  };
  return { gh, git, board, asked };
}

async function run(fixture: string, setup: Setup = {}, input: Record<string, unknown> = {}) {
  const { gh, git, board, asked } = fake(setup);
  const out: string[] = [];
  const errors: string[] = [];
  const stdin = JSON.stringify({
    session_id: 's', transcript_path: join(FIXTURES, fixture), cwd: '/Users/danyel/code/MISC/torahmap', stop_hook_active: false, hook_event_name: 'Stop', ...input,
  });
  const code = await main({ gh, git, board, stdin, out: (l) => out.push(l), err: (l) => errors.push(l) });
  return { code, out, errors, asked, block: out.length ? (JSON.parse(out.join('')) as { decision: string; reason: string }) : null };
}

describe('status-check hook', () => {
  it('passes when the status was written this turn', async () => {
    const r = await run('pr-comment.jsonl', { record: { writtenAt: '2026-11-05T10:30:00Z' } });
    expect(r.out).toEqual([]);
    expect(r.asked[0]).toContain('/api/work?repo=danyelf%2Ftorahmap&number=574');
  });

  it('passes when the status was confirmed this turn', async () => {
    const r = await run('pr-comment.jsonl', { record: { writtenAt: '2026-11-05T09:00:00Z', confirmedAt: '2026-11-05T10:40:00Z' } });
    expect(r.out).toEqual([]);
  });

  it('blocks when the status was written and confirmed before the turn', async () => {
    const r = await run('pr-comment.jsonl', { record: { writtenAt: '2026-11-05T09:30:00Z', confirmedAt: '2026-11-05T09:40:00Z' } });
    expect(r.code).toBe(0);
    expect(r.block?.decision).toBe('block');
    expect(r.block?.reason).toContain('danyelf/torahmap#574');
    expect(r.block?.reason).toContain(`node ${join(import.meta.dirname, '..', 'cli', 'pr-status.ts')} set <ref> --gate`);
  });

  it('blocks when the board has no record', async () => {
    const r = await run('pr-comment.jsonl', { record: null });
    expect(r.block?.reason).toContain('danyelf/torahmap#574 has no status on the board; run pr-status set');
  });

  it('blocks once with the warning when the board cannot be reached', async () => {
    const r = await run('pr-comment.jsonl', { boardDown: true });
    expect(r.block?.reason).toContain('⚠️');
    expect(r.block?.reason).toContain("Couldn't reach the board");
    expect(r.errors).toEqual([]);
  });

  it('lets the stop through when the hook already blocked once and the board is down', async () => {
    const r = await run('pr-comment.jsonl', { boardDown: true }, { stop_hook_active: true });
    expect(r.out).toEqual([]);
  });

  it('does nothing when the stop hook is already active', async () => {
    expect((await run('pr-comment.jsonl', {}, { stop_hook_active: true })).out).toEqual([]);
  });

  it('does nothing when no GitHub commands ran', async () => {
    expect((await run('no-github.jsonl')).out).toEqual([]);
  });

  it('blocks once saying the check failed when gh fails, and lets the retry through', async () => {
    const r = await run('pr-comment.jsonl', { throwOn: 'repo view' });
    expect(r.code).toBe(0);
    expect(r.block?.decision).toBe('block');
    expect(r.block?.reason).toBe('status-check failed: boom');
    const again = await run('pr-comment.jsonl', { throwOn: 'repo view' }, { stop_hook_active: true });
    expect(again.out).toEqual([]);
  });

  it('skips a transcript line that is not JSON, and does not block a turn that touched nothing', async () => {
    const r = await run('cut-short.jsonl');
    expect(r.out).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('takes a push whose repo cannot be looked up as touching nothing', async () => {
    const r = await run('push.jsonl', { throwOn: 'repo view', headPrs: [31] });
    expect(r.out).toEqual([]);
    const list = await run('push.jsonl', { throwOn: 'pr list' });
    expect(list.out).toEqual([]);
  });

  it('takes the number of a created PR from the tool result URL', async () => {
    const r = await run('pr-create.jsonl');
    expect(r.block?.reason).toContain('danyelf/torahmap#580');
  });

  it('starts the turn at a pasted image plus text, not an earlier message', async () => {
    const r = await run('image-paste.jsonl');
    expect(r.block?.reason).toContain('#574');
    expect(r.block?.reason).not.toContain('#500');
  });

  it('looks up the current branch PR when the command gives no number', async () => {
    const r = await run('comment-no-number.jsonl');
    expect(r.block?.reason).toContain('danyelf/torahmap#574');
  });

  it('does not treat injected meta messages as the start of a turn', async () => {
    const r = await run('meta-after-command.jsonl');
    expect(r.block?.reason).toContain('danyelf/torahmap#574');
  });

  it('ignores a lone merge', async () => {
    expect((await run('merge-only.jsonl')).out).toEqual([]);
  });

  it('finds the PR for a pushed branch', async () => {
    const r = await run('push.jsonl', { headPrs: [31], branch: 'feature-x' });
    expect(r.block?.reason).toContain('danyelf/torahmap#31');
  });

  it('checks an issue the same way', async () => {
    const stale = await run('issue-comment.jsonl', { record: { writtenAt: '2026-11-05T09:00:00Z' } });
    expect(stale.block?.reason).toContain('danyelf/torahmap#12');
    const fresh = await run('issue-comment.jsonl', { record: { writtenAt: '2026-11-05T10:30:00Z' } });
    expect(fresh.out).toEqual([]);
  });

  it('reads repo from api paths and -R flags, and skips pr-status calls', async () => {
    const r = await run('api-and-skips.jsonl');
    const reason = r.block?.reason ?? '';
    expect(reason).toContain('acme/y#9');
    expect(reason).toContain('acme/q#7');
    expect(reason).not.toContain('acme/z#3');
  });
});
