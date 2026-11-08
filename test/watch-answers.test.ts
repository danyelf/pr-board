import { describe, expect, it } from 'vitest';
import { LOOK_DEFAULT, renderAnswer } from '../src/shared/answer.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { renderStatus } from '../src/shared/status.ts';
import type { Status } from '../src/shared/types.ts';
import type { Gh } from '../cli/gh.ts';
import { main } from '../cli/watch-answers.ts';

interface Comment { id: number; user: { login: string }; body: string; html_url: string; created_at: string; updated_at: string }
interface Item { kind: 'pr' | 'issue'; body: string; comments: Comment[]; state: 'open' | 'closed'; lastEditedAt: string | null; createdAt: string }

const POLL = 60_000;
const COLLECT = 60_000;
const MAX_BACKOFF = 300_000;
/** When pr-status wrote the status; the World's clock starts after it. */
const WRITTEN = '2026-11-08T10:00:00.000Z';
const asking: Status = { waitingOn: 'owner', since: null, ask: 'look', questions: [{ n: 1, text: 'Colour?', choices: ['leave', 'change'], defaultChoice: 'leave' }], toTest: null, writtenAt: WRITTEN };

class World {
  items = new Map<string, Item>();
  reactions = new Map<number, string[]>();
  me = 'robot';
  /** Answers another session of the same account claims just before this one does. */
  lostRace = new Set<number>();
  failChecks = 0;
  failRepoLookups = 0;
  nextId = 100;
  /** Minutes after WRITTEN, moved on by each comment. */
  clock = 1;
  calls: string[] = [];

  item(ref: string, kind: 'pr' | 'issue' = 'pr', status: Status = asking): Item {
    const it: Item = { kind, body: renderStatus(status), comments: [], state: 'open', lastEditedAt: null, createdAt: '2026-11-01T00:00:00Z' };
    this.items.set(ref, it);
    return it;
  }

  answer(ref: string, answers: Record<string, string>, over: { login?: string; fingerprint?: string; note?: string; at?: string } = {}): number {
    const id = this.nextId++;
    const body = renderAnswer(asking, { fingerprint: over.fingerprint ?? statusFingerprint(asking), answers, note: over.note ?? '' });
    const at = over.at ?? new Date(Date.parse(WRITTEN) + this.clock++ * 60_000).toISOString();
    this.items.get(ref)!.comments.push({ id, user: { login: over.login ?? 'sam-gh' }, body, html_url: `https://github.com/${ref.replace('#', '/pull/')}#issuecomment-${id}`, created_at: at, updated_at: at });
    return id;
  }

  gh: Gh = async (args) => {
    const line = args.join(' ');
    this.calls.push(line);
    if (line === 'api user -q .login') return `${this.me}\n`;
    if (line === 'repo view --json nameWithOwner -q .nameWithOwner') {
      if (this.failRepoLookups > 0) { this.failRepoLookups--; throw new Error('gh: could not reach GitHub'); }
      return 'acme/x\n';
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const value = (name: string) => args.find((a) => a.startsWith(`${name}=`))!.slice(name.length + 1);
      const it = this.items.get(`${value('owner')}/${value('repo')}#${value('n')}`)!;
      return `${it.lastEditedAt ?? it.createdAt}\n`;
    }
    const comments = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=100 --paginate --slurp$/.exec(line);
    if (comments) {
      if (this.failChecks > 0) { this.failChecks--; throw new Error('gh: HTTP 502 Bad Gateway'); }
      const item = this.items.get(`${comments[1]}#${comments[2]}`)!;
      return JSON.stringify([item.comments.map((c) => ({ ...c, reactions: { eyes: (this.reactions.get(c.id) ?? []).length } }))]);
    }
    const item = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(line);
    if (item) {
      const it = this.items.get(`${item[1]}#${item[2]}`)!;
      return JSON.stringify({ state: it.state, body: it.kind === 'pr' ? it.body : 'issue text', ...(it.kind === 'pr' ? { pull_request: {} } : {}) });
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
    expect(r.sleeps).toEqual([POLL, POLL, POLL, COLLECT]);
    expect(w.reactions.get(id)).toEqual(['robot']);
    expect(r.out).toContain(`acme/x#5: https://github.com/acme/x/pull/5#issuecomment-${id}`);
    expect(r.out).toContain(`fingerprint ${statusFingerprint(asking)} matches the current status`);
    expect(r.out).toContain('1. Colour? → change');
    expect(r.out).toContain('How does it look? → looks good, prep for merge');
    expect(r.out).toContain('Note: tint is strong\n    but fine');
  });

  it('passes over answers written before the status, and reads no reactions for them', async () => {
    const w = new World();
    w.item('acme/x#5');
    const old = w.answer('acme/x#5', { '1': 'leave' }, { at: '2026-11-08T09:00:00Z' });
    let fresh = 0;
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 2) fresh = w.answer('acme/x#5', { '1': 'change' }); });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(`issuecomment-${old}`);
    expect(r.out).toContain(`issuecomment-${fresh}`);
    expect(w.calls.some((c) => c.includes(`comments/${old}/reactions`))).toBe(false);
  });

  it("times a status edited by hand by the PR's last description edit, and an issue's by its status comment", async () => {
    const w = new World();
    const pr = w.item('acme/x#5');
    pr.body = pr.body.replace('**Ask:** look', '**Ask:** look again');
    pr.lastEditedAt = '2026-11-08T10:30:00Z';
    const beforeEdit = w.answer('acme/x#5', { '1': 'leave' }, { at: '2026-11-08T10:20:00Z' });
    const issue = w.item('acme/y#7', 'issue');
    issue.comments.push({ id: 1, user: { login: 'danyel-claude' }, body: renderStatus({ ...asking, writtenAt: undefined }), html_url: 'x', created_at: '2026-11-08T08:00:00Z', updated_at: '2026-11-08T10:30:00Z' });
    const beforeStatus = w.answer('acme/y#7', { '1': 'leave' }, { at: '2026-11-08T10:25:00Z' });
    const after = w.answer('acme/y#7', { '1': 'change' }, { at: '2026-11-08T10:40:00Z' });
    const r = await watch(w, ['acme/x#5', 'acme/y#7']);
    expect(r.out).not.toContain(`issuecomment-${beforeEdit}`);
    expect(r.out).not.toContain(`issuecomment-${beforeStatus}`);
    expect(r.out).toContain(`issuecomment-${after}`);
  });

  it('drops an item that is closed or merged, and stops, saying so, once none is left', async () => {
    const w = new World();
    const pr = w.item('acme/x#5');
    w.item('acme/y#7', 'issue');
    const r = await watch(w, ['acme/x#5', 'acme/y#7'], (n) => {
      if (n === 1) pr.state = 'closed';
      if (n === 3) w.items.get('acme/y#7')!.state = 'closed';
    });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([POLL, POLL, POLL]);
    expect(r.out).toContain('acme/x#5 is closed or merged; no longer watching it.');
    expect(r.out).toContain('acme/y#7 is closed or merged; no longer watching it.');
    expect(r.out).toContain('nothing left to watch');
  });

  it("works out a #N reference's repo inside the loop, so a passing failure is retried rather than fatal", async () => {
    const w = new World();
    w.item('acme/x#5');
    w.answer('acme/x#5', { '1': 'leave' });
    w.failRepoLookups = 2;
    const r = await watch(w, ['#5']);
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([120_000, 240_000, COLLECT]);
    expect(r.err).toContain('could not reach GitHub');
    expect(r.out).toContain('acme/x#5: https://github.com/acme/x/pull/5#issuecomment-');
  });

  it("passes over answers already claimed, other people's comments, and comments not in the answer format", async () => {
    const w = new World();
    const item = w.item('acme/x#5');
    const claimed = w.answer('acme/x#5', { '1': 'leave' });
    w.reactions.set(claimed, ['other-bot']);
    w.answer('acme/x#5', { '1': 'leave' }, { login: 'bob' });
    item.comments.push({ id: 1, user: { login: 'sam-gh' }, body: 'Answers: 1 leave', html_url: 'x', created_at: '2026-11-08T11:00:00Z', updated_at: '2026-11-08T11:00:00Z' });
    let fresh = 0;
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 2) fresh = w.answer('acme/x#5', { '1': 'change' }); });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([POLL, POLL, COLLECT]);
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
    const r = await watch(w, ['acme/x#5', 'acme/y#7'], (n, ms) => { if (n === 1 && ms === COLLECT) second = w.answer('acme/y#7', { '1': 'change' }); });
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
    expect(r.sleeps).toEqual([120_000, 240_000, MAX_BACKOFF, MAX_BACKOFF, MAX_BACKOFF, MAX_BACKOFF, COLLECT]);
    expect(r.err).toContain('HTTP 502 Bad Gateway');
    expect(r.err.split('\n').filter((l) => l.includes('trying again')).length).toBe(6);
  });

  it('goes back to the ordinary wait once a check works again', async () => {
    const w = new World();
    w.item('acme/x#5');
    w.failChecks = 2;
    const r = await watch(w, ['acme/x#5'], (n) => { if (n === 4) w.answer('acme/x#5', { '1': 'leave' }); });
    expect(r.sleeps).toEqual([120_000, 240_000, POLL, POLL, COLLECT]);
  });

  it("refuses to start under the owner's own account, whose 👀 the board does not count", async () => {
    const w = new World();
    w.me = 'sam-gh';
    w.item('acme/x#5');
    const id = w.answer('acme/x#5', { '1': 'leave' });
    const r = await watch(w, ['acme/x#5']);
    expect(r.code).toBe(1);
    expect(r.sleeps).toEqual([]);
    expect(r.err).toContain("gh is signed in as sam-gh, the board's owner");
    expect(w.reactions.get(id)).toBeUndefined();
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
