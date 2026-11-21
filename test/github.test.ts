import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchFacts, setLabels } from '../src/worker/github.ts';
import { MANAGED_LABELS, labelChanges, wantedLabels } from '../src/worker/labels.ts';
import { answerFacts, recordedFacts } from './github-fake.ts';

const NOW = new Date('2026-11-20T22:00:00Z');
const REPO = 'danyelf/torahmap';

function repoFixture(): any {
  return JSON.parse(readFileSync(new URL('./fixtures/graphql-repos.json', import.meta.url), 'utf8'));
}

interface FakeOptions {
  repos?: any;
  itemsFor?: (repo: string) => any;
  graphqlErrors?: Record<string, string>; // repo name -> message
  behind?: Record<string, number>;        // "base...head" -> behind_by
  status?: number;
}

function fake(opts: FakeOptions = {}) {
  const calls: { url: string; method: string; query?: string }[] = [];
  const fn = (async (input: any, init?: any) => {
    const url = String(input);
    const sent = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, method: init?.method ?? 'GET', query: sent.query });
    if (opts.status && opts.status !== 200) return new Response('nope', { status: opts.status, statusText: 'Bad' });
    if (url === 'https://api.github.com/graphql') {
      const query: string = sent.query;
      if (query.includes('viewer')) return Response.json(opts.repos ?? repoFixture());
      const data: Record<string, any> = {};
      const errors: any[] = [];
      for (const m of query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
        const [, alias, owner, name] = m;
        const message = opts.graphqlErrors?.[name!];
        if (message) { data[alias!] = null; errors.push({ path: [alias], message }); continue; }
        const answer = answerFacts(query, opts.itemsFor ? opts.itemsFor(`${owner}/${name}`) : recordedFacts());
        data[alias!] = answer;
        for (const [key, value] of Object.entries(answer)) {
          if (/^i\d+$/.test(key) && value === null) errors.push({ type: 'NOT_FOUND', path: [alias, key], message: `Could not resolve to an issue or pull request with the number of ${key.slice(1)}.` });
        }
      }
      return Response.json(errors.length ? { data, errors } : { data });
    }
    const compare = url.match(/\/compare\/(.+)$/);
    if (compare) return Response.json({ behind_by: opts.behind?.[decodeURIComponent(compare[1]!)] ?? 0 });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

const get = (facts: { number: number }[], n: number) => facts.find((f) => f.number === n) as any;

describe('fetchFacts', () => {
  it('reads the head commit, review decision and checks of an open PR', async () => {
    const { facts, errors } = await fetchFacts('tok', [], NOW, fake().fn);
    expect(errors).toEqual([]);
    const pr = get(facts, 641);
    expect(pr.kind).toBe('pr');
    expect(pr.repo).toBe(REPO);
    expect(pr.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(pr.headRef).toBe('cantillation-quote-634');
    expect(pr.mergeState).toBe('BLOCKED');
    expect(pr.reviewDecision).toBe('REVIEW_REQUIRED');
    expect(pr.checks).toBe('SUCCESS');
    expect(pr.closedAt).toBeNull();
    expect(pr.merged).toBe(false);
    expect(pr.labels).toEqual(['on danyel']);
    expect(pr.previewUrl).toMatch(/^https:\/\//);
    expect(pr.linkedIssue).toBeTypeOf('number');
  });

  it('reads only open PRs from a repo, plus the numbers asked for', async () => {
    const { facts } = await fetchFacts('tok', [], NOW, fake().fn);
    expect(facts.map((f) => f.number).sort()).toEqual([640, 641]);
  });

  it('reads a listed number that is closed, with when it closed and whether it merged', async () => {
    const { facts, errors } = await fetchFacts('tok', [{ repo: REPO, numbers: [626, 631] }], NOW, fake().fn);
    expect(errors).toEqual([]);
    const merged = get(facts, 626);
    expect(merged.merged).toBe(true);
    expect(merged.closedAt).toBe('2026-11-20T19:10:09Z');
    const closed = get(facts, 631);
    expect(closed.merged).toBe(false);
    expect(closed.closedAt).toBe('2026-11-20T20:00:55Z');
  });

  it('reads an issue, with the PR-only facts empty', async () => {
    const { facts } = await fetchFacts('tok', [{ repo: REPO, numbers: [638] }], NOW, fake().fn);
    const issue = get(facts, 638);
    expect(issue.kind).toBe('issue');
    expect(issue.headSha).toBeNull();
    expect(issue.mergeState).toBeNull();
    expect(issue.reviewDecision).toBeNull();
    expect(issue.checks).toBeNull();
    expect(issue.isDraft).toBe(false);
    expect(issue.screenshots).toEqual(expect.any(Array));
  });

  it('lists a number that is also an open PR once', async () => {
    const { facts } = await fetchFacts('tok', [{ repo: REPO, numbers: [641] }], NOW, fake().fn);
    expect(facts.filter((f) => f.number === 641)).toHaveLength(1);
  });

  it('still reads a repo that was not pushed to within 60 days when a number in it is listed', async () => {
    const repos = { data: { viewer: { repositories: { nodes: [
      { nameWithOwner: REPO, pushedAt: '2025-01-01T00:00:00Z', defaultBranchRef: { name: 'main' } },
    ] } } } };
    const without = await fetchFacts('tok', [], NOW, fake({ repos }).fn);
    expect(without.facts).toEqual([]);
    const listed = await fetchFacts('tok', [{ repo: REPO, numbers: [626] }], NOW, fake({ repos }).fn);
    expect(get(listed.facts, 626)).toBeDefined();
  });

  it('reads a listed repo the token does not list at all', async () => {
    const repos = { data: { viewer: { repositories: { nodes: [] } } } };
    const { facts } = await fetchFacts('tok', [{ repo: REPO, numbers: [626] }], NOW, fake({ repos }).fn);
    expect(get(facts, 626)).toBeDefined();
  });

  it('says so, and keeps the rest, when a listed number is not found', async () => {
    const { facts, errors } = await fetchFacts('tok', [{ repo: REPO, numbers: [99999, 626] }], NOW, fake().fn);
    expect(get(facts, 626)).toBeDefined();
    expect(errors).toEqual([`Couldn't read ${REPO}#99999: Could not resolve to an issue or pull request with the number of 99999.`]);
  });

  it('skips repos not pushed within 60 days, and reads the rest in one query', async () => {
    const { fn, calls } = fake();
    await fetchFacts('tok', [], NOW, fn);
    expect(calls.filter((c) => c.url.endsWith('/graphql'))).toHaveLength(2); // repos, then one batch
  });

  it('batches at most five repos per query', async () => {
    const nodes = Array.from({ length: 7 }, (_, i) => ({ nameWithOwner: `danyelf/r${i}`, pushedAt: '2026-11-19T04:44:20Z', defaultBranchRef: { name: 'main' } }));
    const { fn, calls } = fake({ repos: { data: { viewer: { repositories: { nodes } } } } });
    await fetchFacts('tok', [], NOW, fn);
    expect(calls.filter((c) => c.url.endsWith('/graphql'))).toHaveLength(3); // repos + 5 + 2
  });

  it('asks only for the last 20 comments, and only for who wrote them and what they say', async () => {
    const { fn, calls } = fake();
    await fetchFacts('tok', [], NOW, fn);
    const query = calls.find((c) => c.query?.includes('repository('))!.query!;
    expect(query).toContain('comments(last:20){pageInfo{hasPreviousPage} nodes{author{login} body}}');
    expect(query).not.toMatch(/timelineItems|reactions|files\(/);
  });

  it('reads the screenshots in a PR description', async () => {
    const { facts } = await fetchFacts('tok', [], NOW, fake().fn);
    expect(get(facts, 640).screenshots.length).toBeGreaterThan(0);
  });

  it('takes the last activity from when the item was last updated', async () => {
    const { facts } = await fetchFacts('tok', [], NOW, fake().fn);
    const raw = recordedFacts().pullRequests.nodes.find((p: any) => p.number === 641);
    expect(get(facts, 641).lastActivityAt).toBe(raw.updatedAt);
  });

  it('uses a closing issue as the linked issue only when it is in the same repo, else Refs #N', async () => {
    const itemsFor = (changeRepo: boolean) => () => {
      const data = recordedFacts();
      const pr = data.pullRequests.nodes.find((p: any) => p.number === 641);
      pr.closingIssuesReferences.nodes = [{ number: 7, repository: { nameWithOwner: changeRepo ? 'someone/else' : REPO } }];
      pr.body = 'Refs #9';
      return data;
    };
    const same = await fetchFacts('tok', [], NOW, fake({ itemsFor: itemsFor(false) }).fn);
    expect(get(same.facts, 641).linkedIssue).toBe(7);
    const other = await fetchFacts('tok', [], NOW, fake({ itemsFor: itemsFor(true) }).fn);
    expect(get(other.facts, 641).linkedIssue).toBe(9);
  });

  it('marks stackedOn, and whether the PR it is stacked on is still open', async () => {
    const itemsFor = (on: number) => () => {
      const data = recordedFacts();
      data.pullRequests.nodes.find((p: any) => p.number === 641).body = `Stacked on #${on}`;
      return data;
    };
    const open = await fetchFacts('tok', [], NOW, fake({ itemsFor: itemsFor(640) }).fn);
    expect(get(open.facts, 641).stackedOn).toBe(640);
    expect(get(open.facts, 641).stackedOnOpen).toBe(true);
    const merged = await fetchFacts('tok', [], NOW, fake({ itemsFor: itemsFor(626) }).fn);
    expect(get(merged.facts, 641).stackedOn).toBe(626);
    expect(get(merged.facts, 641).stackedOnOpen).toBe(false);
  });

  it('flags an open PR whose base has moved ahead, and compares only open PRs', async () => {
    const { fn, calls } = fake({ behind: { 'main...cantillation-quote-634': 3 } });
    const { facts } = await fetchFacts('tok', [{ repo: REPO, numbers: [626, 638] }], NOW, fn);
    expect(get(facts, 641).behindBase).toBe(true);
    expect(get(facts, 640).behindBase).toBe(false);
    expect(get(facts, 626).behindBase).toBe(false);
    expect(calls.filter((c) => c.url.includes('/compare/'))).toHaveLength(2);
  });

  it('does not compare PRs from forks with a base', async () => {
    const itemsFor = () => {
      const data = recordedFacts();
      data.pullRequests.nodes.find((p: any) => p.number === 641).isCrossRepository = true;
      return data;
    };
    const { fn, calls } = fake({ itemsFor });
    const { errors } = await fetchFacts('tok', [], NOW, fn);
    expect(calls.filter((c) => c.url.includes('/compare/'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('checks at most 20 PRs against their base and says how many it skipped', async () => {
    const itemsFor = () => {
      const data = recordedFacts();
      const open = data.pullRequests.nodes.find((p: any) => p.number === 641);
      for (let n = 1000; n < 1024; n++) data.pullRequests.nodes.unshift({ ...structuredClone(open), number: n });
      return data;
    };
    const { fn, calls } = fake({ itemsFor });
    const { errors } = await fetchFacts('tok', [], NOW, fn);
    expect(calls.filter((c) => c.url.includes('/compare/'))).toHaveLength(20);
    expect(errors).toContain("Didn't check 6 PRs against their base branch");
  });

  it('names a repo it could not read and keeps the others', async () => {
    const repos = { data: { viewer: { repositories: { nodes: [
      { nameWithOwner: REPO, pushedAt: '2026-11-19T04:44:20Z', defaultBranchRef: { name: 'main' } },
      { nameWithOwner: 'danyelf/broken', pushedAt: '2026-11-19T04:44:20Z', defaultBranchRef: { name: 'main' } },
    ] } } } };
    const { facts, errors } = await fetchFacts('tok', [], NOW, fake({ repos, graphqlErrors: { broken: 'Could not resolve' } }).fn);
    expect(get(facts, 641)).toBeDefined();
    expect(errors).toEqual(["Couldn't read danyelf/broken: Could not resolve"]);
  });

  it('skips a repo whose list of open PRs is missing, and names it', async () => {
    const fn = fake().fn;
    const wrapped = (async (input: any, init?: any) => {
      const res = await fn(input, init);
      if (!String(input).endsWith('/graphql') || !JSON.parse(init.body).query.includes('repository(')) return res;
      const body: any = await res.json();
      body.data.r0.openPrs = null;
      return Response.json(body);
    }) as typeof fetch;
    const { facts, errors } = await fetchFacts('tok', [], NOW, wrapped);
    expect(facts).toEqual([]);
    expect(errors).toEqual([`Couldn't read ${REPO}: GitHub sent no list of open PRs`]);
  });

  it('says so when a list of labels was cut off, or the open PRs fill the page', async () => {
    const itemsFor = () => {
      const data = recordedFacts();
      data.pullRequests.nodes.find((p: any) => p.number === 641).labels.pageInfo = { hasNextPage: true };
      const open = data.pullRequests.nodes.find((p: any) => p.number === 641);
      for (let n = 2000; n < 2050; n++) data.pullRequests.nodes.push({ ...structuredClone(open), number: n });
      return data;
    };
    const { errors } = await fetchFacts('tok', [], NOW, fake({ itemsFor }).fn);
    expect(errors).toContain(`More than 20 labels on ${REPO}#641; a board label may be missing`);
    expect(errors).toContain(`More than 50 open PRs in ${REPO}; some may be missing from this page`);
  });

  it('returns no facts and one error on a non-200 answer', async () => {
    const { facts, errors } = await fetchFacts('tok', [], NOW, fake({ status: 401 }).fn);
    expect(facts).toEqual([]);
    expect(errors).toEqual(['GitHub said 401 Bad']);
  });

  it('sends the token and user agent', async () => {
    let seen: any;
    const inner = fake().fn;
    const fn = (async (i: any, init?: any) => { seen ??= init?.headers; return inner(i, init); }) as typeof fetch;
    await fetchFacts('tok', [], NOW, fn);
    expect(seen.Authorization).toBe('bearer tok');
    expect(seen['User-Agent']).toBe('pr-board');
  });
});

describe('setLabels', () => {
  const facts = { repo: 'acme/x', number: 5 } as any;

  function recorder(answer: (url: string, method: string) => Response) {
    const seen: { url: string; method: string; auth: string; body?: unknown }[] = [];
    const fn = (async (input: any, init?: any) => {
      seen.push({ url: String(input), method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
      return answer(String(input), init.method);
    }) as typeof fetch;
    return { fn, seen };
  }

  it('adds labels in one call and removes each one in its own', async () => {
    const { fn, seen } = recorder(() => Response.json([]));
    await setLabels('tok', facts, ['gate: prep', 'on sam'], ['gate: design', 'parked'], fn);
    expect(seen).toEqual([
      { url: 'https://api.github.com/repos/acme/x/issues/5/labels', method: 'POST', auth: 'bearer tok', body: { labels: ['gate: prep', 'on sam'] } },
      { url: 'https://api.github.com/repos/acme/x/issues/5/labels/gate%3A%20design', method: 'DELETE', auth: 'bearer tok', body: undefined },
      { url: 'https://api.github.com/repos/acme/x/issues/5/labels/parked', method: 'DELETE', auth: 'bearer tok', body: undefined },
    ]);
  });

  it('sends nothing when there is nothing to change', async () => {
    const { fn, seen } = recorder(() => Response.json([]));
    await setLabels('tok', facts, [], [], fn);
    expect(seen).toEqual([]);
  });

  it('does not mind removing a label the item no longer has', async () => {
    const { fn } = recorder((_url, method) => (method === 'DELETE' ? new Response('gone', { status: 404, statusText: 'Not Found' }) : Response.json([])));
    await expect(setLabels('tok', facts, [], ['parked'], fn)).resolves.toBeUndefined();
  });

  it("throws with GitHub's explanation when it refuses", async () => {
    const { fn } = recorder(() => Response.json({ message: 'Resource not accessible' }, { status: 403, statusText: 'Forbidden' }));
    await expect(setLabels('tok', facts, ['parked'], [], fn)).rejects.toThrow('GitHub said 403 Forbidden: Resource not accessible');
  });
});

describe('wantedLabels', () => {
  it('gives the gate, whose turn it is, and ready to merge', () => {
    expect(wantedLabels({ gate: 'prep', turn: 'owner', ready: true })).toEqual(['gate: prep', 'on sam', 'ready to merge']);
  });

  it('gives only the gate while Claude has the turn', () => {
    expect(wantedLabels({ gate: 'implementation', turn: 'claude', ready: false })).toEqual(['gate: implementation']);
  });

  it('gives parked when nobody has the turn', () => {
    expect(wantedLabels({ gate: 'design', turn: 'nobody', ready: false })).toEqual(['gate: design', 'parked']);
  });

  it('gives no gate label when there is no gate', () => {
    expect(wantedLabels({ gate: null, turn: 'claude', ready: false })).toEqual([]);
  });
});

describe('labelChanges', () => {
  it('adds what is missing and removes managed labels that are no longer wanted', () => {
    expect(labelChanges(['gate: design', 'on sam'], ['gate: implementation', 'on sam'])).toEqual({
      add: ['gate: implementation'], remove: ['gate: design'],
    });
  });

  it('never removes in-progress or a label the board does not manage', () => {
    expect(labelChanges(['in-progress', 'P2', 'bug', 'on sam'], [])).toEqual({ add: [], remove: ['on sam'] });
  });

  it('never adds a label the board does not manage', () => {
    expect(labelChanges([], ['in-progress', 'P2', 'parked'])).toEqual({ add: ['parked'], remove: [] });
  });

  it('changes nothing when the labels already match', () => {
    expect(labelChanges(['parked', 'P2'], ['parked'])).toEqual({ add: [], remove: [] });
  });

  it('manages the six labels, and not in-progress', () => {
    expect([...MANAGED_LABELS]).toEqual(['gate: design', 'gate: implementation', 'gate: prep', 'on sam', 'ready to merge', 'parked']);
  });
});
