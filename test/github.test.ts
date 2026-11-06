import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchItems } from '../src/worker/github.ts';

const NOW = new Date('2026-11-06T06:00:00Z');

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

interface FakeOptions {
  repos?: any;
  itemsFor?: (repo: string) => any;
  graphqlErrors?: Record<string, string>; // repo name -> message
  behind?: Record<string, number>;        // "base...head" -> behind_by
  status?: number;
}

function fake(opts: FakeOptions = {}) {
  const calls: { url: string; method: string }[] = [];
  const items = fixture('graphql-items.json').data.r0;
  const fn = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (opts.status && opts.status !== 200) return new Response('nope', { status: opts.status, statusText: 'Bad' });
    if (url === 'https://api.github.com/graphql') {
      const query: string = JSON.parse(init.body).query;
      if (query.includes('viewer')) return Response.json(opts.repos ?? fixture('graphql-repos.json'));
      const data: Record<string, any> = {};
      const errors: any[] = [];
      for (const m of query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
        const [, alias, owner, name] = m;
        const message = opts.graphqlErrors?.[name];
        if (message) { data[alias] = null; errors.push({ path: [alias], message }); }
        else data[alias] = opts.itemsFor ? opts.itemsFor(`${owner}/${name}`) : items;
      }
      return Response.json(errors.length ? { data, errors } : { data });
    }
    const compare = url.match(/\/compare\/(.+)$/);
    if (compare) return Response.json({ behind_by: opts.behind?.[decodeURIComponent(compare[1])] ?? 0 });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

describe('fetchItems', () => {
  it('reads the PR facts the board needs', async () => {
    const { fn } = fake();
    const { items, errors } = await fetchItems('tok', NOW, fn);
    expect(errors).toEqual([]);
    const get = (n: number) => items.find((i) => i.number === n)!;

    const p573 = get(573);
    expect(p573.kind).toBe('pr');
    expect(p573.repo).toBe('danyelf/torahmap');
    expect(p573.linkedIssue).toBe(569);
    expect(p573.reviewSha).toBe('bd275212');
    expect(p573.commitsSinceReview).toBe(1);
    expect(p573.reviewUrl).toMatch(/^https:\/\/github.com\/danyelf\/torahmap\/pull\/573#issuecomment-/);
    expect(p573.previewUrl).toBe('https://panels-unchanged-torahmap.danyel.workers.dev');
    expect(p573.prepDone).toBe(false);
    expect(p573.commitsSincePrep).toBeNull();

    expect(get(574).stackedOn).toBe(573);
    expect(get(574).stackedOnOpen).toBe(false);

    const p578 = get(578);
    expect(p578.prepDone).toBe(true);
    expect(p578.commitsSincePrep).toBe(2);
    expect(p578.screenshots).toHaveLength(2);
    expect(p578.reviewSha).toBe('629776d');
    expect(p578.commitsSinceReview).toBe(3);

    expect(get(576).merged).toBe(true);
    expect(get(576).mergedAt).not.toBeNull();
    expect(get(564).merged).toBe(false);
    expect(get(564).mergeState).toBe('BLOCKED');
    expect(get(564).addedDocs).toEqual([
      { path: 'docs/plans/2026-11-02-code-map-design.md', url: 'https://github.com/danyelf/torahmap/pull/564/files' },
    ]);
  });

  it('includes issues carrying a turn label, with the status comment', async () => {
    const { fn } = fake();
    const { items } = await fetchItems('tok', NOW, fn);
    const issue = items.find((i) => i.number === 563)!;
    expect(issue.kind).toBe('issue');
    expect(issue.labels).toContain('in-progress');
    expect(issue.mergeState).toBeNull();
    expect(issue.labelEvents.length).toBeGreaterThan(0);
    const times = issue.labelEvents.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('drops issues without a turn label, and PRs closed more than 7 days ago', async () => {
    const itemsFor = () => {
      const data = fixture('graphql-items.json').data.r0;
      const old = structuredClone(data.pullRequests.nodes.find((p: any) => p.number === 576));
      old.number = 1; old.closedAt = '2026-10-01T00:00:00Z'; old.mergedAt = '2026-10-01T00:00:00Z';
      data.pullRequests.nodes.push(old);
      const plain = structuredClone(data.issues.nodes[0]);
      plain.number = 2; plain.labels.nodes = [{ name: 'P2' }];
      data.issues.nodes.push(plain);
      return data;
    };
    const { items } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(items.find((i) => i.number === 1)).toBeUndefined();
    expect(items.find((i) => i.number === 2)).toBeUndefined();
    expect(items.find((i) => i.number === 563)).toBeDefined();
  });

  it('skips repos not pushed within 60 days', async () => {
    const { fn, calls } = fake();
    await fetchItems('tok', NOW, fn);
    const bodies = calls.filter((c) => c.url.endsWith('/graphql'));
    expect(bodies).toHaveLength(2); // repos, then one batch
  });

  it('computes lastActivityAt as the latest activity time', async () => {
    const { items } = await fetchItems('tok', NOW, fake().fn);
    const p578 = items.find((i) => i.number === 578)!;
    expect(p578.activityTimes).toContain('2026-11-06T00:19:40Z');
    expect(p578.lastActivityAt).toBe('2026-11-06T00:26:11Z');
  });

  it('marks stackedOnOpen when the base PR is still open', async () => {
    const itemsFor = () => {
      const data = fixture('graphql-items.json').data.r0;
      const p574 = data.pullRequests.nodes.find((p: any) => p.number === 574);
      p574.body = 'Stacked on #564';
      return data;
    };
    const { items } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(items.find((i) => i.number === 574)!.stackedOnOpen).toBe(true);
  });

  it('flags an open PR whose base has moved ahead', async () => {
    const { fn, calls } = fake({ behind: { 'main...codemap-design': 3 } });
    const { items } = await fetchItems('tok', NOW, fn);
    expect(items.find((i) => i.number === 564)!.behindBase).toBe(true);
    expect(items.find((i) => i.number === 573)!.behindBase).toBe(false);
    expect(calls.filter((c) => c.url.includes('/compare/'))).toHaveLength(1);
    expect(calls.every((c) => c.method === 'POST' || c.method === 'GET')).toBe(true);
  });

  it('checks at most 20 PRs against their base and says how many it skipped', async () => {
    const itemsFor = () => {
      const data = fixture('graphql-items.json').data.r0;
      const open = data.pullRequests.nodes.find((p: any) => p.number === 564);
      for (let n = 1000; n < 1024; n++) {
        const copy = structuredClone(open);
        copy.number = n;
        data.pullRequests.nodes.push(copy);
      }
      return data;
    };
    const { fn, calls } = fake({ itemsFor });
    const { errors } = await fetchItems('tok', NOW, fn);
    expect(calls.filter((c) => c.url.includes('/compare/'))).toHaveLength(20);
    expect(errors).toEqual(["Didn't check 5 PRs against main"]);
  });

  it('keeps the other repos when one fails, and names the failing repo', async () => {
    const repos = {
      data: { viewer: { repositories: { nodes: [
        { nameWithOwner: 'danyelf/torahmap', pushedAt: '2026-11-06T04:44:20Z', defaultBranchRef: { name: 'main' } },
        { nameWithOwner: 'danyelf/broken', pushedAt: '2026-11-05T04:44:20Z', defaultBranchRef: { name: 'main' } },
      ] } } },
    };
    const { items, errors } = await fetchItems('tok', NOW, fake({ repos, graphqlErrors: { broken: 'Could not resolve' } }).fn);
    expect(items.find((i) => i.number === 573)).toBeDefined();
    expect(errors).toEqual(["Couldn't read danyelf/broken: Could not resolve"]);
  });

  it('batches at most five repos per query', async () => {
    const nodes = Array.from({ length: 7 }, (_, i) => ({
      nameWithOwner: `danyelf/r${i}`, pushedAt: '2026-11-05T04:44:20Z', defaultBranchRef: { name: 'main' },
    }));
    const repos = { data: { viewer: { repositories: { nodes } } } };
    const { fn, calls } = fake({ repos });
    await fetchItems('tok', NOW, fn);
    expect(calls.filter((c) => c.url.endsWith('/graphql'))).toHaveLength(3); // repos + 5 + 2
  });

  it('returns no items and one error on a non-200 answer', async () => {
    const { items, errors } = await fetchItems('tok', NOW, fake({ status: 401 }).fn);
    expect(items).toEqual([]);
    expect(errors).toEqual(['GitHub said 401 Bad']);
  });

  it('sends the token and user agent', async () => {
    let seen: any;
    const inner = fake().fn;
    const fn = (async (i: any, init?: any) => { seen ??= init?.headers; return inner(i, init); }) as typeof fetch;
    await fetchItems('tok', NOW, fn);
    expect(seen.Authorization).toBe('bearer tok');
    expect(seen['User-Agent']).toBe('pr-board');
  });
});
