import { describe, expect, it } from 'vitest';
import { BoardError } from '../cli/board.ts';
import { main } from '../cli/pr-status.ts';
import type { Gh } from '../cli/gh.ts';

interface World {
  kind: 'pr' | 'issue';
  body: string;
  author: string;
  reviewers: string[];
  reviewFails?: boolean;
  readFails?: boolean;
  /** What the board answers to POST /api/status. */
  handedOver: boolean;
}

function fakeGh(world: World) {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (line === 'api repos/acme/x/issues/5') {
      if (world.readFails) throw new Error('gh: API rate limit exceeded (HTTP 403)');
      return JSON.stringify({ body: world.body, user: { login: world.author }, ...(world.kind === 'pr' ? { pull_request: {} } : {}) });
    }
    if (line.startsWith('api -X POST repos/acme/x/pulls/5/requested_reviewers')) {
      if (world.reviewFails) throw new Error('gh: Reviews may only be requested from collaborators (HTTP 422)');
      world.reviewers.push(args[args.length - 1]!.replace('reviewers[]=', ''));
      return '{}';
    }
    if (line === 'repo view --json nameWithOwner -q .nameWithOwner') return 'acme/x\n';
    if (line === 'issue edit 5 -R acme/x --add-label in-progress') return '';
    throw new Error(`unexpected gh call: ${line}`);
  };
  return { gh, calls };
}

function world(over: Partial<World> = {}): World {
  return { kind: 'pr', body: 'Does a thing.\n\nCloses #3\n', author: 'robot', reviewers: [], handedOver: false, ...over };
}

interface Sent { method: string; path: string; body: unknown }

interface Reply { status?: number; body: unknown; html?: boolean }

async function run(w: World, argv: string[], reply: (sent: Sent) => Reply = () => ({ body: { record: { version: 2 }, handedOver: w.handedOver } }), files: Record<string, string> = {}) {
  const { gh, calls } = fakeGh(w);
  const lines: string[] = [];
  const errors: string[] = [];
  const sent: Sent[] = [];
  const code = await main(argv, {
    gh,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    board: {
      home: '/home/test',
      env: {},
      readFile: (p) => files[p] ?? '{"clientId":"i","clientSecret":"s"}',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        const s: Sent = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
        sent.push(s);
        const r = reply(s);
        if (r.html) return new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    },
  });
  return { code, calls, lines, errors, sent };
}

const SET = ['set', 'acme/x#5', '--gate', 'implementation', '--state', 'paused', '--ask', 'look', '--question', 'Colour? (**red** | green)'];

describe('pr-status set', () => {
  it('posts the status to the board with no issue, leaving the link to the board, and reads nothing from GitHub', async () => {
    const r = await run(world(), [...SET, '--to-test', 'open it', '--reason', 'why', '--replaces', '4']);
    expect(r.code).toBe(0);
    expect(r.sent).toEqual([{
      method: 'POST', path: '/api/status',
      body: {
        repo: 'acme/x', number: 5, gate: 'implementation', state: 'paused', ask: 'look', questions: ['Colour? (**red** | green)'],
        toTest: 'open it', reason: 'why', noDesign: false, issue: null, replaces: 4,
      },
    }]);
    expect(r.calls).toEqual([]);
  });

  it('sends --issue when given, as an override', async () => {
    const r = await run(world(), [...SET, '--issue', '9', '--no-design']);
    expect(r.code).toBe(0);
    expect(r.sent[0]!.body).toMatchObject({ issue: 9, noDesign: true, toTest: null, reason: null, replaces: null });
    expect(r.calls).toEqual([]);
  });

  it('refuses without --gate and --state, with a usage line, before any call', async () => {
    for (const argv of [['set', 'acme/x#5', '--ask', 'x'], ['set', 'acme/x#5', '--gate', 'design']]) {
      const r = await run(world(), argv);
      expect(r.code).toBe(1);
      expect(r.errors.join('\n')).toContain('Usage: pr-status set');
      expect(r.sent).toEqual([]);
    }
  });

  it('leaves the checks of the gate, the state, line breaks and questions to the board, which refuses before writing', async () => {
    const argv = ['set', 'acme/x#5', '--gate', 'build', '--state', 'done', '--to-test', '1. pin\n2. press', '--question', 'Colour? (red | green)'];
    const r = await run(world(), argv, () => ({ status: 400, body: { error: '"gate" must be one of design, implementation, prep' } }));
    expect(r.code).toBe(1);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.body).toMatchObject({ gate: 'build', state: 'done', toTest: '1. pin\n2. press', questions: ['Colour? (red | green)'] });
    expect(r.errors).toEqual(['"gate" must be one of design, implementation, prep']);
  });

  it('refuses a flag it does not know, such as the old --waiting', async () => {
    const r = await run(world(), [...SET, '--waiting', 'owner']);
    expect(r.code).toBe(1);
    expect(r.errors.join('\n')).toContain('Unknown option --waiting');
    expect(r.sent).toEqual([]);
  });

  it('prints the board\'s text and exits 1 when it refuses', async () => {
    const r = await run(world(), SET, () => ({ status: 409, body: { error: 'Design hasn\'t been approved' } }));
    expect(r.code).toBe(1);
    expect(r.errors).toEqual(['Design hasn\'t been approved']);
  });

  it('says ⚠️ and exits 1 when Access answers with a login page', async () => {
    const r = await run(world(), SET, () => ({ body: null, html: true }));
    expect(r.code).toBe(1);
    expect(r.errors[0]).toMatch(/^⚠️ .*access-token\.json/);
  });
});

describe('pr-status set asks the owner to review', () => {
  it('when the board says the PR was handed over', async () => {
    const w = world({ handedOver: true });
    const r = await run(w, SET);
    expect(r.code).toBe(0);
    expect(w.reviewers).toEqual(['sam-gh']);
  });

  it('not when it was not handed over', async () => {
    const w = world();
    await run(w, SET);
    expect(w.reviewers).toEqual([]);
  });

  it('not for an issue, or when the owner opened the PR', async () => {
    const issue = world({ kind: 'issue', handedOver: true });
    await run(issue, SET);
    expect(issue.reviewers).toEqual([]);
    const own = world({ author: 'sam-gh', handedOver: true });
    expect((await run(own, SET)).code).toBe(0);
    expect(own.reviewers).toEqual([]);
  });

  it('exits 1 saying why when the request fails, after the status was written', async () => {
    const r = await run(world({ handedOver: true, reviewFails: true }), SET);
    expect(r.code).toBe(1);
    expect(r.sent).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Couldn't ask sam-gh to review acme\/x#5: .*HTTP 422/);
    expect(r.errors[1]).toMatch(/^⚠️ The status was recorded on the board/);
    expect(r.errors[1]).toContain('Run: gh pr edit 5 -R acme/x --add-reviewer sam-gh');
  });

  it('says the status was recorded and how to ask for the review by hand when the PR cannot be read', async () => {
    const w = world({ handedOver: true, readFails: true });
    const r = await run(w, SET);
    expect(r.code).toBe(1);
    expect(r.sent).toHaveLength(1);
    expect(w.reviewers).toEqual([]);
    expect(r.errors[0]).toContain('rate limit');
    expect(r.errors[1]).toMatch(/^⚠️ The status was recorded on the board/);
    expect(r.errors[1]).toContain('If #5 is a pull request, run: gh pr edit 5 -R acme/x --add-reviewer sam-gh');
  });
});

describe('pr-status ok, show and import', () => {
  it('ok posts the item to /api/ok', async () => {
    const r = await run(world(), ['ok', 'acme/x#5'], () => ({ body: { record: {} } }));
    expect(r.code).toBe(0);
    expect(r.sent).toEqual([{ method: 'POST', path: '/api/ok', body: { repo: 'acme/x', number: 5 } }]);
  });

  it('show prints the board\'s answer as JSON', async () => {
    const r = await run(world(), ['show', 'acme/x#5'], () => ({ body: { record: { gate: 'design' }, answers: [] } }));
    expect(r.sent).toEqual([{ method: 'GET', path: '/api/work?repo=acme%2Fx&number=5', body: undefined }]);
    expect(JSON.parse(r.lines.join('\n'))).toEqual({ record: { gate: 'design' }, answers: [] });
  });

  it('show says there is no record, and exits 1, on a 404', async () => {
    const r = await run(world(), ['show', 'acme/x#5'], () => ({ status: 404, body: { error: 'acme/x#5 is not open on the board' } }));
    expect(r.code).toBe(1);
    expect(r.errors.join('\n')).toContain('acme/x#5 has no record on the board');
    expect(r.errors.join('\n')).not.toContain('⚠️');
  });

  it('import posts a record from a file', async () => {
    const record = { gate: 'design', state: 'working', reached: 'design' };
    const r = await run(world(), ['import', 'acme/x#5', '--json', '/tmp/rec.json'], () => ({ body: { record } }), { '/tmp/rec.json': JSON.stringify(record) });
    expect(r.code).toBe(0);
    expect(r.sent).toEqual([{ method: 'POST', path: '/api/import', body: { repo: 'acme/x', number: 5, record } }]);
  });

  it('import needs --json', async () => {
    const r = await run(world(), ['import', 'acme/x#5']);
    expect(r.code).toBe(1);
    expect(r.errors.join('\n')).toContain('--json');
  });

  it('resolves #N against the repo in the current directory', async () => {
    const r = await run(world(), ['ok', '#5'], () => ({ body: { record: {} } }));
    expect(r.sent[0]!.body).toEqual({ repo: 'acme/x', number: 5 });
  });

  it('a BoardError is exported for callers', () => {
    expect(new BoardError('⚠️ x').message).toBe('⚠️ x');
  });
});

describe('pr-status and the backlog', () => {
  it('propose sends the items as the board takes them, and refuses a bad one before sending anything', async () => {
    const r = await run(world(), ['propose', 'acme/x', '--item', '#25 | pick up | small', '--item', '#11 | close | done by #20'], () => ({ body: { proposal: {} } }));
    expect(r.code).toBe(0);
    expect(r.sent).toEqual([{ method: 'POST', path: '/api/proposal-write', body: { repo: 'acme/x', items: [{ issue: 25, suggestion: 'pick up', reason: 'small' }, { issue: 11, suggestion: 'close', reason: 'done by #20' }] } }]);
    const bad = await run(world(), ['propose', 'acme/x', '--item', '#25 | maybe | small']);
    expect(bad.code).toBe(1);
    expect(bad.errors.join('\n')).toContain('"maybe" isn\'t pick up, later, close or waiting');
    expect(bad.sent).toEqual([]);
  });

  it('propose with no items writes an empty list', async () => {
    const r = await run(world(), ['propose', 'acme/x'], () => ({ body: { proposal: {} } }));
    expect(r.code).toBe(0);
    expect(r.sent[0]!.body).toEqual({ repo: 'acme/x', items: [] });
  });

  it('pick-up labels the issue and adds it to the board', async () => {
    const r = await run(world({ kind: 'issue' }), ['pick-up', 'acme/x#5'], () => ({ body: { pickup: {} } }));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.join(' '))).toEqual(['issue edit 5 -R acme/x --add-label in-progress']);
    expect(r.sent).toEqual([{ method: 'POST', path: '/api/pickup-add', body: { repo: 'acme/x', number: 5, proposalId: null } }]);
  });

  it('proposal-done finishes the repo’s proposal, or hands it back with --problem', async () => {
    const ok = await run(world(), ['proposal-done', 'acme/x'], () => ({ body: {} }));
    expect(ok.sent[0]!.body).toEqual({ repo: 'acme/x', problem: '' });
    const back = await run(world(), ['proposal-done', 'acme/x', '--problem', "#19 doesn't exist"], () => ({ body: {} }));
    expect(back.sent[0]!.body).toEqual({ repo: 'acme/x', problem: "#19 doesn't exist" });
    expect((await run(world(), ['proposal-done', 'acme/x#5'])).code).toBe(1);
  });
});
