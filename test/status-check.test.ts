import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../hooks/status-check.ts';
import type { Gh } from '../cli/gh.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'transcripts');
const MARKER_BODY = '<!-- status -->\n**Waiting on:** Danyel\n**Ask:** x\n<!-- /status -->\n\nbody';

interface Setup {
  lastEditedAt?: string | null;
  body?: string;
  events?: { event: string; label: { name: string }; created_at: string }[];
  comments?: { body: string; updated_at: string }[];
  throwOn?: string;
  issueIsPr?: boolean;
  headPrs?: number[];
  branch?: string;
}

function fake(setup: Setup = {}) {
  const calls: string[][] = [];
  const gh: Gh = async (args, opts) => {
    calls.push(args);
    const line = args.join(' ');
    if (setup.throwOn && line.includes(setup.throwOn)) throw new Error('boom');
    if (args[0] === 'repo' && args[1] === 'view') {
      return opts?.cwd?.endsWith('torahmap') ? 'danyelf/torahmap\n' : 'other/repo\n';
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ data: { repository: { pullRequest: { lastEditedAt: setup.lastEditedAt ?? null, body: setup.body ?? '' } } } });
    }
    if (/^api repos\/[^/]+\/[^/]+\/issues\/\d+\/events/.test(line)) return JSON.stringify([setup.events ?? []]);
    if (/^api repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/.test(line)) return JSON.stringify([setup.comments ?? []]);
    if (/^api repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(line)) return JSON.stringify(setup.issueIsPr ? { pull_request: {} } : {});
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify((setup.headPrs ?? []).map((number) => ({ number })));
    if (args[0] === 'pr' && args[1] === 'view') return '574\n';
    throw new Error(`unexpected gh call: ${line}`);
  };
  const git: Gh = async () => `${setup.branch ?? 'feature-x'}\n`;
  return { gh, git, calls };
}

async function run(fixture: string, setup: Setup = {}, input: Record<string, unknown> = {}, checked?: string) {
  const { gh, git } = fake(setup);
  const home = await mkdtemp(join(tmpdir(), 'pr-board-'));
  if (checked) {
    await mkdir(join(home, '.pr-board'));
    await writeFile(join(home, '.pr-board', 'checked.jsonl'), checked);
  }
  const out: string[] = [];
  const errors: string[] = [];
  const stdin = JSON.stringify({
    session_id: 's', transcript_path: join(FIXTURES, fixture), cwd: '/Users/danyel/code/MISC/torahmap', stop_hook_active: false, hook_event_name: 'Stop', ...input,
  });
  const code = await main([], { gh, git, now: () => new Date('2026-11-05T11:00:00Z'), home, stdin, out: (l) => out.push(l), err: (l) => errors.push(l) });
  return { code, out, errors, block: out.length ? (JSON.parse(out.join('')) as { decision: string; reason: string }) : null };
}

describe('status-check hook', () => {
  it('blocks when a commented PR has an old description', async () => {
    const r = await run('pr-comment.jsonl', { lastEditedAt: '2026-11-05T09:30:00Z', body: MARKER_BODY });
    expect(r.code).toBe(0);
    expect(r.block?.decision).toBe('block');
    expect(r.block?.reason).toContain('danyelf/torahmap#574');
    expect(r.block?.reason).toContain('node /Users/danyel/code/MISC/pr-board/cli/pr-status.ts set <ref> --waiting');
  });

  it('is satisfied by a description edited this turn that has the status marker', async () => {
    const r = await run('pr-comment.jsonl', { lastEditedAt: '2026-11-05T10:30:00Z', body: MARKER_BODY });
    expect(r.out).toEqual([]);
  });

  it('is not satisfied by a recent edit with no status marker', async () => {
    const r = await run('pr-comment.jsonl', { lastEditedAt: '2026-11-05T10:30:00Z', body: 'no marker' });
    expect(r.block?.reason).toContain('#574');
  });

  it('is satisfied by a label change this turn', async () => {
    const r = await run('pr-comment.jsonl', { events: [{ event: 'labeled', label: { name: 'on danyel' }, created_at: '2026-11-05T10:20:00Z' }] });
    expect(r.out).toEqual([]);
  });

  it('ignores label changes from before the turn and unrelated labels', async () => {
    const r = await run('pr-comment.jsonl', {
      events: [
        { event: 'labeled', label: { name: 'parked' }, created_at: '2026-11-05T09:00:00Z' },
        { event: 'labeled', label: { name: 'bug' }, created_at: '2026-11-05T10:20:00Z' },
      ],
    });
    expect(r.block).not.toBeNull();
  });

  it('is satisfied by an "ok" line this turn, not by an older one', async () => {
    const fresh = await run('pr-comment.jsonl', {}, {}, '{"ref":"danyelf/torahmap#574","at":"2026-11-05T10:40:00Z"}\n');
    expect(fresh.out).toEqual([]);
    const stale = await run('pr-comment.jsonl', {}, {}, '{"ref":"danyelf/torahmap#574","at":"2026-11-05T09:40:00Z"}\n');
    expect(stale.block).not.toBeNull();
  });

  it('does nothing when no GitHub commands ran', async () => {
    expect((await run('no-github.jsonl')).out).toEqual([]);
  });

  it('does nothing when the stop hook is already active', async () => {
    expect((await run('pr-comment.jsonl', {}, { stop_hook_active: true })).out).toEqual([]);
  });

  it('prints nothing and one stderr line when gh fails', async () => {
    const r = await run('pr-comment.jsonl', { throwOn: 'graphql' });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([]);
    expect(r.errors).toHaveLength(1);
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

  it('checks the status comment on an issue', async () => {
    const stale = await run('issue-comment.jsonl', { comments: [{ body: MARKER_BODY, updated_at: '2026-11-05T09:00:00Z' }] });
    expect(stale.block?.reason).toContain('danyelf/torahmap#12');
    const fresh = await run('issue-comment.jsonl', { comments: [{ body: MARKER_BODY, updated_at: '2026-11-05T10:30:00Z' }] });
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
