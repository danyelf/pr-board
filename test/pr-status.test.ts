import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../cli/pr-status.ts';
import type { Gh } from '../cli/gh.ts';
import { parseStatus } from '../src/shared/status.ts';

interface World {
  kind: 'pr' | 'issue';
  body: string;
  comments: { id: number; body: string; user: { login: string } }[];
  labels: Set<string>;      // labels on the item
  repoLabels: Set<string>;  // labels that exist in the repo
}

function fakeGh(world: World) {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (line === 'api repos/acme/x/issues/5') {
      return JSON.stringify({ body: world.body, ...(world.kind === 'pr' ? { pull_request: {} } : {}) });
    }
    if (line.startsWith('api -X PATCH repos/acme/x/pulls/5')) {
      world.body = args[args.length - 1]!.replace(/^body=/, '');
      return '{}';
    }
    if (line === 'api user -q .login') return 'danyelf\n';
    if (line.startsWith('api repos/acme/x/issues/5/comments')) return JSON.stringify([world.comments]);
    if (line.startsWith('api -X PATCH repos/acme/x/issues/comments/')) {
      const id = Number(args[3]!.split('/').pop());
      world.comments.find((c) => c.id === id)!.body = args[args.length - 1]!.replace(/^body=/, '');
      return '{}';
    }
    if (line.startsWith('api -X POST repos/acme/x/issues/5/comments')) {
      world.comments.push({ id: 99, body: args[args.length - 1]!.replace(/^body=/, ''), user: { login: 'danyelf' } });
      return '{}';
    }
    const getLabel = /^api repos\/acme\/x\/labels\/(.+)$/.exec(line);
    if (getLabel) {
      if (!world.repoLabels.has(decodeURIComponent(getLabel[1]!))) throw new Error('gh: Not Found (HTTP 404)');
      return '{}';
    }
    if (line.startsWith('api -X POST repos/acme/x/issues/5/labels')) {
      world.labels.add(args[args.length - 1]!.replace('labels[]=', ''));
      return '[]';
    }
    const del = /^api -X DELETE repos\/acme\/x\/issues\/5\/labels\/(.+)$/.exec(line);
    if (del) {
      const name = decodeURIComponent(del[1]!);
      if (!world.labels.has(name)) throw new Error('gh: Label does not exist (HTTP 404)');
      world.labels.delete(name);
      return '[]';
    }
    throw new Error(`unexpected gh call: ${line}`);
  };
  return { gh, calls };
}

function world(over: Partial<World> = {}): World {
  return { kind: 'pr', body: 'Old description\n', comments: [], labels: new Set(), repoLabels: new Set(['on danyel', 'parked']), ...over };
}

async function run(w: World, argv: string[], at = '2026-11-05T10:00:00.000Z') {
  const { gh, calls } = fakeGh(w);
  const lines: string[] = [];
  const errors: string[] = [];
  const home = await mkdtemp(join(tmpdir(), 'pr-board-'));
  const code = await main(argv, { gh, now: () => new Date(at), home, out: (l) => lines.push(l), err: (l) => errors.push(l) });
  return { code, calls, lines, errors, home };
}

const SET = ['set', 'acme/x#5', '--waiting', 'danyel', '--ask', 'look', '--question', 'Colour? (**red** | green)'];
const patches = (calls: string[][]) => calls.filter((c) => c[0] === 'api' && c[1] === '-X' && c[2] === 'PATCH');

describe('pr-status set', () => {
  it('rewrites a PR description, keeps the old body, and flips labels', async () => {
    const w = world({ labels: new Set(['in-progress']) });
    const r = await run(w, SET);
    expect(r.code).toBe(0);
    expect(patches(r.calls)).toHaveLength(1);
    expect(w.body.startsWith('<!-- status -->\n**Waiting on:** Danyel, since 2026-11-05T10:00:00.000Z')).toBe(true);
    expect(w.body).toContain('1. Colour?  (**red** | green)');
    expect(w.body.endsWith('<!-- /status -->\n\nOld description\n')).toBe(true);
    expect(w.labels.has('on danyel')).toBe(true);
    expect(r.calls.some((c) => c.join(' ').includes('-X DELETE repos/acme/x/issues/5/labels/parked'))).toBe(true);
  });

  it('still exits 0 when removing a label that is not there returns 404', async () => {
    const r = await run(world(), SET);
    expect(r.code).toBe(0);
  });

  it('keeps the first since when waiting-on does not change', async () => {
    const w = world();
    await run(w, SET, '2026-11-05T10:00:00.000Z');
    await run(w, SET, '2026-11-06T10:00:00.000Z');
    expect(parseStatus(w.body)?.since).toBe('2026-11-05T10:00:00.000Z');
    await run(w, ['set', 'acme/x#5', '--waiting', 'claude', '--ask', 'x'], '2026-11-07T10:00:00.000Z');
    expect(parseStatus(w.body)?.since).toBe('2026-11-07T10:00:00.000Z');
  });

  it('refuses a question without a bold default and writes nothing', async () => {
    const r = await run(world(), ['set', 'acme/x#5', '--waiting', 'danyel', '--ask', 'a', '--question', 'Colour? (red | green)']);
    expect(r.code).toBe(1);
    expect(r.errors.join('\n')).toContain('bold default');
    expect(patches(r.calls)).toHaveLength(0);
  });

  it('edits the existing status comment on an issue instead of adding one', async () => {
    const w = world({
      kind: 'issue',
      comments: [
        { id: 7, body: 'someone else', user: { login: 'bob' } },
        { id: 8, body: '<!-- status -->\n**Waiting on:** Claude, since 2026-11-01T00:00:00.000Z\n**Ask:** x\n<!-- /status -->', user: { login: 'danyelf' } },
      ],
    });
    const r = await run(w, SET);
    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.join(' ').startsWith('api -X PATCH repos/acme/x/issues/comments/8'))).toBe(true);
    expect(r.calls.some((c) => c.join(' ').startsWith('api -X POST repos/acme/x/issues/5/comments'))).toBe(false);
    expect(w.comments).toHaveLength(2);
    expect(parseStatus(w.comments[1]!.body)?.waitingOn).toBe('Danyel');
  });

  it('creates a status comment on an issue that has none', async () => {
    const w = world({ kind: 'issue' });
    await run(w, SET);
    expect(w.comments).toHaveLength(1);
    expect(parseStatus(w.comments[0]!.body)?.ask).toBe('look');
  });

  it('writes the status, then exits 1 naming a label the repo lacks', async () => {
    const w = world({ repoLabels: new Set() });
    const r = await run(w, SET);
    expect(r.code).toBe(1);
    expect(r.errors).toContain(`Label "on danyel" doesn't exist in acme/x; run cli/setup-labels.ts`);
    expect(patches(r.calls)).toHaveLength(1);
    expect(r.calls.some((c) => c.join(' ').includes('POST repos/acme/x/issues/5/labels'))).toBe(false);
  });

  it('parks: adds parked and removes on danyel', async () => {
    const w = world({ labels: new Set(['on danyel']) });
    await run(w, ['set', 'acme/x#5', '--waiting', 'nobody', '--ask', 'x']);
    expect([...w.labels]).toEqual(['parked']);
  });
});

describe('pr-status ok and show', () => {
  it('appends a line to checked.jsonl', async () => {
    const r = await run(world(), ['ok', 'acme/x#5']);
    const text = await readFile(join(r.home, '.pr-board', 'checked.jsonl'), 'utf8');
    expect(JSON.parse(text.trim())).toEqual({ ref: 'acme/x#5', at: '2026-11-05T10:00:00.000Z' });
  });

  it('prints null when there is no status, JSON when there is', async () => {
    const w = world();
    expect((await run(w, ['show', 'acme/x#5'])).lines).toEqual(['null']);
    await run(w, SET);
    expect(JSON.parse((await run(w, ['show', 'acme/x#5'])).lines[0]!).waitingOn).toBe('Danyel');
  });
});

describe('refs', () => {
  it('resolves #N against the repo in the current directory', async () => {
    const w = world();
    const inner = fakeGh(w).gh;
    const gh: Gh = async (args, o) => (args[0] === 'repo' ? 'acme/x\n' : inner(args, o));
    const code = await main(['ok', '#5'], { gh, now: () => new Date(), home: await mkdtemp(join(tmpdir(), 'pr-board-')), out: () => {}, err: () => {} });
    expect(code).toBe(0);
  });
});
