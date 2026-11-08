import { describe, expect, it } from 'vitest';
import { LOOK_DEFAULT, renderAnswer } from '../src/shared/answer.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { renderStatus } from '../src/shared/status.ts';
import type { Status } from '../src/shared/types.ts';
import type { Gh } from '../cli/gh.ts';
import { COLLECT_MS, MAX_BACKOFF_MS, POLL_MS, main } from '../cli/watch-answers.ts';

interface Comment { id: number; user: { login: string }; body: string; html_url: string }
interface Item { kind: 'pr' | 'issue'; body: string; comments: Comment[] }

const asking: Status = { waitingOn: 'owner', since: null, ask: 'look', questions: [{ n: 1, text: 'Colour?', choices: ['leave', 'change'], defaultChoice: 'leave' }], toTest: null };

class World {
  items = new Map<string, Item>();
  reactions = new Map<number, string[]>();
  me = 'robot';
  /** Answers another session of the same account claims just before this one does. */
  lostRace = new Set<number>();
  failChecks = 0;
  nextId = 100;

  item(ref: string, kind: 'pr' | 'issue' = 'pr', status: Status = asking): Item {
    const it: Item = { kind, body: renderStatus(status), comments: [] };
    this.items.set(ref, it);
    return it;
  }

  answer(ref: string, answers: Record<string, string>, over: { login?: string; fingerprint?: string; note?: string } = {}): number {
    const id = this.nextId++;
    const body = renderAnswer(asking, { fingerprint: over.fingerprint ?? statusFingerprint(asking), answers, note: over.note ?? '' });
    this.items.get(ref)!.comments.push({ id, user: { login: over.login ?? 'sam-gh' }, body, html_url: `https://github.com/${ref.replace('#', '/pull/')}#issuecomment-${id}` });
    return id;
  }

  gh: Gh = async (args) => {
    const line = args.join(' ');
    if (line === 'api user -q .login') return `${this.me}\n`;
    const comments = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=100 --paginate --slurp$/.exec(line);
    if (comments) {
      if (this.failChecks > 0) { this.failChecks--; throw new Error('gh: HTTP 502 Bad Gateway'); }
      const item = this.items.get(`${comments[1]}#${comments[2]}`)!;
      return JSON.stringify([item.comments.map((c) => ({ ...c, reactions: { eyes: (this.reactions.get(c.id) ?? []).length } }))]);
    }
    const item = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(line);
    if (item) {
      const it = this.items.get(`${item[1]}#${item[2]}`)!;
      return JSON.stringify({ body: it.kind === 'pr' ? it.body : 'issue text', ...(it.kind === 'pr' ? { pull_request: {} } : {}) });
    }
    const list = /^api repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions\?content=eyes&per_page=100 --paginate --slurp$/.exec(line);
    if (list) return JSON.stringify([(this.reactions.get(Number(list[1])) ?? []).map((login) => ({ user: { login }, content: 'eyes' }))]);
    const react = /^api -X POST repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions -f content=eyes --include$/.exec(line);
    if (react) {
      const id = Number(react[1]);
      const who = this.reactions.get(id) ?? [];
      const already = who.includes(this.me) || this.lostRace.has(id);
      if (!who.includes(this.me)) this.reactions.set(id, [...who, this.me]);
      return already ? 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{}' : 'HTTP/2.0 201 Created\nContent-Type: application/json\n\n{}';
    }
    throw new Error(`unexpected gh call: ${line}`);
  };
}

async function watch(world: World, argv: string[], onSleep: (count: number, ms: number) => void = () => {}) {
  const sleeps: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    if (sleeps.length > 500) throw new Error('the watcher never stopped');
    onSleep(sleeps.length, ms);
  };
  const code = await main(argv, { gh: world.gh, sleep, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, sleeps, out: out.join('\n'), err: err.join('\n') };
}

describe('watch-answers', () => {
  it('checks once a minute until an answer comes, waits a minute more, claims it with 👀 and prints it', async () => {
    const w = new World();
    w.item('acme/x#5');
    let id = 0;
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 3) id = w.answer('acme/x#5', { '1': 'change', look: LOOK_DEFAULT }, { note: 'tint is strong\nbut fine' }); });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS, COLLECT_MS]);
    expect(w.reactions.get(id)).toEqual(['robot']);
    expect(r.out).toContain(`acme/x#5: https://github.com/acme/x/pull/5#issuecomment-${id}`);
    expect(r.out).toContain(`fingerprint ${statusFingerprint(asking)} matches the current status`);
    expect(r.out).toContain('1. Colour? → change');
    expect(r.out).toContain('How does it look? → looks good, prep for merge');
    expect(r.out).toContain('Note: tint is strong\n    but fine');
    expect(POLL_MS).toBe(60_000);
    expect(COLLECT_MS).toBe(60_000);
  });

  it("passes over answers already claimed, other people's comments, and comments not in the answer format", async () => {
    const w = new World();
    const item = w.item('acme/x#5');
    const claimed = w.answer('acme/x#5', { '1': 'leave' });
    w.reactions.set(claimed, ['other-bot']);
    w.answer('acme/x#5', { '1': 'leave' }, { login: 'bob' });
    item.comments.push({ id: 1, user: { login: 'sam-gh' }, body: 'Answers: 1 leave', html_url: 'x' });
    let fresh = 0;
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 2) fresh = w.answer('acme/x#5', { '1': 'change' }); });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([POLL_MS, POLL_MS, COLLECT_MS]);
    expect(r.out).toContain(`issuecomment-${fresh}`);
    expect(r.out).not.toContain(`issuecomment-${claimed}`);
    expect(w.reactions.get(claimed)).toEqual(['other-bot']);
  });

  it("doesn't count the owner's own 👀 as a claim", async () => {
    const w = new World();
    w.item('acme/x#5');
    const id = w.answer('acme/x#5', { '1': 'leave' });
    w.reactions.set(id, ['sam-gh']);
    const r = await watch(w, ['acme/x#5']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`issuecomment-${id}`);
    expect(w.reactions.get(id)).toEqual(['sam-gh', 'robot']);
  });

  it('collects an answer on another item that comes in during the extra minute', async () => {
    const w = new World();
    w.item('acme/x#5');
    w.item('acme/y#7', 'issue');
    const first = w.answer('acme/x#5', { '1': 'leave' });
    let second = 0;
    const r = await watch(w, ['acme/x#5', 'acme/y#7'], (_n, ms) => { if (ms === COLLECT_MS) second = w.answer('acme/y#7', { '1': 'change' }); });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`issuecomment-${first}`);
    expect(r.out).toContain(`acme/y#7: https://github.com/acme/y/pull/7#issuecomment-${second}`);
    expect(w.reactions.get(first)).toEqual(['robot']);
    expect(w.reactions.get(second)).toEqual(['robot']);
  });

  it("says when an answer's fingerprint doesn't match the current status, and to ask again", async () => {
    const w = new World();
    w.item('acme/x#5');
    w.answer('acme/x#5', { '1': 'change' }, { fingerprint: 'abcdef12' });
    const r = await watch(w, ['acme/x#5']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`fingerprint abcdef12 does NOT match the current status (${statusFingerprint(asking)})`);
    expect(r.out).toContain('ask again');
    expect(r.out).toContain('1 → change');
  });

  it("skips an answer another session claimed first, and keeps watching", async () => {
    const w = new World();
    w.item('acme/x#5');
    const lost = w.answer('acme/x#5', { '1': 'leave' });
    w.lostRace.add(lost);
    let fresh = 0;
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 4) fresh = w.answer('acme/x#5', { '1': 'change' }); });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(`issuecomment-${lost}`);
    expect(r.out).toContain(`issuecomment-${fresh}`);
  });

  it('keeps going through errors, waiting longer each time up to 5 minutes, and never exits because of them', async () => {
    const w = new World();
    w.item('acme/x#5');
    w.answer('acme/x#5', { '1': 'leave' });
    w.failChecks = 6;
    const r = await watch(w, ['acme/x#5']);
    expect(r.code).toBe(0);
    expect(MAX_BACKOFF_MS).toBe(300_000);
    expect(r.sleeps).toEqual([120_000, 240_000, 300_000, 300_000, 300_000, 300_000, COLLECT_MS]);
    expect(r.err).toContain('HTTP 502 Bad Gateway');
    expect(r.err.split('\n').filter((l) => l.includes('trying again')).length).toBe(6);
  });

  it('goes back to the ordinary wait once a check works again', async () => {
    const w = new World();
    w.item('acme/x#5');
    w.failChecks = 2;
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 4) w.answer('acme/x#5', { '1': 'leave' }); });
    expect(r.sleeps).toEqual([120_000, 240_000, POLL_MS, POLL_MS, COLLECT_MS]);
  });

  it('warns when it runs as the owner, whose 👀 the board does not count', async () => {
    const w = new World();
    w.me = 'sam-gh';
    w.item('acme/x#5');
    w.answer('acme/x#5', { '1': 'leave' });
    const r = await watch(w, ['acme/x#5']);
    expect(r.err).toContain("running as sam-gh, the board's owner");
  });

  it('stops at once with the usage when it is given nothing to watch or a reference it cannot read', async () => {
    const w = new World();
    for (const argv of [[], ['nonsense']]) {
      const r = await watch(w, argv);
      expect(r.code).toBe(1);
      expect(r.sleeps).toEqual([]);
    }
    expect((await watch(w, [])).err).toContain('Usage: watch-answers');
  });
});
