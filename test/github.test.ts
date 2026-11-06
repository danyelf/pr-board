import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchItems } from '../src/worker/github.ts';
import { answerRepo, recordedRepo } from './github-fake.ts';

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
  shape?: (repo: string, data: any) => any; // change what GitHub sends for a repo, after the recorded data is read
}

function fake(opts: FakeOptions = {}) {
  const calls: { url: string; method: string }[] = [];
  const items = recordedRepo();
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
        else {
          const answer = answerRepo(query, opts.itemsFor ? opts.itemsFor(`${owner}/${name}`) : items);
          data[alias] = opts.shape ? opts.shape(`${owner}/${name}`, answer) : answer;
        }
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
    expect(get(574).stackedOnOpen).toBe(true);

    const p578 = get(578);
    expect(p578.prepDone).toBe(true);
    expect(p578.commitsSincePrep).toBe(2);
    expect(p578.screenshots).toHaveLength(2);
    expect(p578.reviewSha).toBe('629776d');
    expect(p578.commitsSinceReview).toBe(3);

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

  it('drops issues without a turn label', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const plain = structuredClone(data.issues.nodes[0]);
      plain.number = 2; plain.labels.nodes = [{ name: 'P2' }];
      data.issues.nodes.push(plain);
      return data;
    };
    const { items } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(items.find((i) => i.number === 2)).toBeUndefined();
    expect(items.find((i) => i.number === 563)).toBeDefined();
  });

  it('reads no closed or merged PRs, even ones closed today', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const today = structuredClone(data.pullRequests.nodes.find((p: any) => p.number === 576));
      today.number = 1; today.closedAt = '2026-11-06T00:00:00Z'; today.mergedAt = '2026-11-06T00:00:00Z';
      data.pullRequests.nodes.unshift(today);
      return data;
    };
    const { items } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(items.find((i) => i.number === 1)).toBeUndefined();
    expect(items.filter((i) => i.kind === 'pr' && (i.merged || i.closedAt !== null))).toEqual([]);
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
    expect(p578.lastActivityAt).toBe('2026-11-06T00:19:40Z');
  });

  it('marks stackedOnOpen when the base PR is still open', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const p574 = data.pullRequests.nodes.find((p: any) => p.number === 574);
      p574.body = 'Stacked on #564';
      return data;
    };
    const { items } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(items.find((i) => i.number === 574)!.stackedOnOpen).toBe(true);
  });

  it('does not mark stackedOnOpen when the base PR has merged', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const p574 = data.pullRequests.nodes.find((p: any) => p.number === 574);
      p574.body = 'Stacked on #576';
      return data;
    };
    const { items } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(items.find((i) => i.number === 574)!.stackedOn).toBe(576);
    expect(items.find((i) => i.number === 574)!.stackedOnOpen).toBe(false);
  });

  it('flags an open PR whose base has moved ahead', async () => {
    const { fn, calls } = fake({ behind: { 'main...codemap-design': 3 } });
    const { items } = await fetchItems('tok', NOW, fn);
    expect(items.find((i) => i.number === 564)!.behindBase).toBe(true);
    expect(items.find((i) => i.number === 573)!.behindBase).toBe(false);
    expect(calls.filter((c) => c.url.includes('/compare/'))).toHaveLength(items.length - items.filter((i) => i.kind === 'issue').length);
    expect(calls.every((c) => c.method === 'POST' || c.method === 'GET')).toBe(true);
  });

  it('checks at most 20 PRs against their base and says how many it skipped', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
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
    expect(errors).toEqual(["Didn't check 8 PRs against their base branch"]); // 4 recorded open PRs + 24 copies, 20 checked
  });

  it('checks the PRs that could be ready to merge first when there are too many to check all', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const open = data.pullRequests.nodes.find((p: any) => p.number === 564);
      for (let n = 1000; n < 1024; n++) data.pullRequests.nodes.unshift({ ...structuredClone(open), number: n });
      // 578 has had prep for merge; with the turn label it could be about to merge, and it is last in the list.
      data.pullRequests.nodes.find((p: any) => p.number === 578).labels.nodes = [{ name: 'on danyel' }];
      return data;
    };
    const { fn, calls } = fake({ itemsFor, behind: { 'main...vis-paper-list': 2 } });
    const { items } = await fetchItems('tok', NOW, fn);
    expect(calls.some((c) => c.url.includes('/compare/main...vis-paper-list'))).toBe(true);
    expect(items.find((i) => i.number === 578)!.behindBase).toBe(true);
  });

  it('does not compare PRs from forks with a base, and does not count them as unchecked', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      data.pullRequests.nodes.find((p: any) => p.number === 564).isCrossRepository = true;
      return data;
    };
    const { fn, calls } = fake({ itemsFor });
    const { errors } = await fetchItems('tok', NOW, fn);
    expect(calls.some((c) => c.url.includes('/compare/main...codemap-design'))).toBe(false);
    expect(errors).toEqual([]);
  });

  it('skips a repo whose list of open PRs is missing, names it, and keeps the others', async () => {
    const repos = { data: { viewer: { repositories: { nodes: [
      { nameWithOwner: 'danyelf/torahmap', pushedAt: '2026-11-06T04:44:20Z', defaultBranchRef: { name: 'main' } },
      { nameWithOwner: 'danyelf/second', pushedAt: '2026-11-05T04:44:20Z', defaultBranchRef: { name: 'main' } },
    ] } } } };
    const shape = (repo: string, data: any) => { if (repo === 'danyelf/second') data.openPrs = null; return data; };
    const { items, errors } = await fetchItems('tok', NOW, fake({ repos, shape }).fn);
    expect(errors).toEqual(["Couldn't read danyelf/second: GitHub sent no list of open PRs"]);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.repo === 'danyelf/torahmap')).toBe(true);
  });

  it('skips a repo when a list inside one of its PRs is missing, rather than showing part of it', async () => {
    const shape = (_repo: string, data: any) => { data.openPrs.nodes[0].timelineItems = null; return data; };
    const { items, errors } = await fetchItems('tok', NOW, fake({ shape }).fn);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Couldn't read danyelf\/torahmap: GitHub sent no label changes for danyelf\/torahmap#\d+$/);
    expect(items).toEqual([]);
  });

  it('ignores null entries in a list', async () => {
    const shape = (_repo: string, data: any) => {
      data.openPrs.nodes.push(null);
      data.openPrs.nodes[0].comments.nodes.unshift(null);
      data.openPrs.nodes[0].commits.nodes.push(null);
      data.onDanyel.nodes.push(null);
      return data;
    };
    const { items, errors } = await fetchItems('tok', NOW, fake({ shape }).fn);
    expect(errors).toEqual([]);
    expect(items.find((i) => i.number === 573)).toBeDefined();
  });

  it('says so when a list inside an item or the list of repos was cut off', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const pr = data.pullRequests.nodes.find((p: any) => p.number === 564);
      pr.labels.pageInfo = { hasNextPage: true };
      pr.comments.pageInfo = { hasPreviousPage: true };
      pr.timelineItems.pageInfo = { hasPreviousPage: true };
      pr.files.pageInfo = { hasNextPage: true };
      pr.commits.pageInfo = { hasPreviousPage: true };
      return data;
    };
    const repos = { data: { viewer: { repositories: { pageInfo: { hasNextPage: true }, nodes: [
      { nameWithOwner: 'danyelf/torahmap', pushedAt: '2026-11-06T04:44:20Z', defaultBranchRef: { name: 'main' } },
    ] } } } };
    const { errors } = await fetchItems('tok', NOW, fake({ itemsFor, repos }).fn);
    expect(errors).toContain('More than 100 repositories; some recently active ones may be missing');
    expect(errors).toContain('More than 20 labels on danyelf/torahmap#564; a turn label may be missing');
    expect(errors).toContain('More than 100 comments on danyelf/torahmap#564; a review or prep note may be missing');
    expect(errors).toContain('More than 100 label changes on danyelf/torahmap#564; how long it has waited may be wrong');
    expect(errors).toContain('More than 100 files on danyelf/torahmap#564; an added design doc may be missing');
    expect(errors).toContain('More than 100 commits on danyelf/torahmap#564; commit counts may be off');
  });

  it('does not worry about more repos when the last one it got is already outside the window', async () => {
    const repos = { data: { viewer: { repositories: { pageInfo: { hasNextPage: true }, nodes: [
      { nameWithOwner: 'danyelf/torahmap', pushedAt: '2026-11-06T04:44:20Z', defaultBranchRef: { name: 'main' } },
      { nameWithOwner: 'danyelf/old', pushedAt: '2025-01-01T00:00:00Z', defaultBranchRef: { name: 'main' } },
    ] } } } };
    const { errors } = await fetchItems('tok', NOW, fake({ repos }).fn);
    expect(errors).toEqual([]);
  });

  it('uses a closing issue as the linked issue only when it is in the same repo', async () => {
    const itemsFor = (changeRepo: boolean) => () => {
      const data = recordedRepo();
      if (changeRepo) data.pullRequests.nodes.find((p: any) => p.number === 573).closingIssuesReferences.nodes[0].repository = { nameWithOwner: 'someone/else' };
      return data;
    };
    const same = await fetchItems('tok', NOW, fake({ itemsFor: itemsFor(false) }).fn);
    expect(same.items.find((i) => i.number === 573)!.linkedIssue).toBe(569);
    const other = await fetchItems('tok', NOW, fake({ itemsFor: itemsFor(true) }).fn);
    expect(other.items.find((i) => i.number === 573)!.linkedIssue).not.toBe(569);
  });

  it('takes an issue status from the last comment that has a status section, and times it', async () => {
    const section = (ask: string) => `<!-- status -->\n**Waiting on:** Claude\n**Ask:** ${ask}\n<!-- /status -->`;
    const comment = (body: string, createdAt: string, updatedAt: string) => ({ author: { login: 'x' }, body, url: 'https://example.com', createdAt, updatedAt });
    const itemsFor = () => {
      const data = recordedRepo();
      const issue = data.issues.nodes.find((i: any) => i.number === 563);
      issue.comments.nodes = [
        comment(section('older'), '2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z'),
        comment(section('newer'), '2026-11-04T10:00:00Z', '2026-11-05T12:00:00Z'),
        comment('just a note', '2026-11-05T15:00:00Z', '2026-11-05T15:00:00Z'),
      ];
      return data;
    };
    const { items } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    const issue = items.find((i) => i.number === 563)!;
    expect(issue.statusCommentBody).toContain('**Ask:** newer');
    expect(issue.statusWrittenAt).toBe('2026-11-05T12:00:00Z');
    expect(issue.lastChangeAt).toBe('2026-11-05T15:00:00Z');
  });

  it('times a PR status by its last description edit, or its creation, and the latest change by commits and comments', async () => {
    const itemsFor = (edited: string | null) => () => {
      const data = recordedRepo();
      data.pullRequests.nodes.find((p: any) => p.number === 564).lastEditedAt = edited;
      return data;
    };
    const edited = (await fetchItems('tok', NOW, fake({ itemsFor: itemsFor('2026-11-05T12:00:00Z') }).fn)).items.find((i) => i.number === 564)!;
    expect(edited.statusWrittenAt).toBe('2026-11-05T12:00:00Z');
    const never = (await fetchItems('tok', NOW, fake({ itemsFor: itemsFor(null) }).fn)).items.find((i) => i.number === 564)!;
    expect(never.statusWrittenAt).toBe(never.createdAt);
    expect(Date.parse(never.lastChangeAt!)).toBeGreaterThan(Date.parse(never.createdAt));
  });

  it('fails when the query asks for a field the recording does not have', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      delete data.pullRequests.nodes.find((p: any) => p.number === 564).mergeStateStatus;
      return data;
    };
    await expect(fetchItems('tok', NOW, fake({ itemsFor }).fn)).rejects.toThrow(/has no mergeStateStatus/);
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

  it('keeps an old open PR that 30 newer merged PRs would push out, and sees what it is stacked on', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const merged = data.pullRequests.nodes.find((p: any) => p.number === 576);
      const open = data.pullRequests.nodes.find((p: any) => p.number === 564);
      const stacked = structuredClone(open);
      stacked.number = 3000; stacked.body = 'Stacked on #564';
      const newer = Array.from({ length: 30 }, (_, k) => ({ ...structuredClone(merged), number: 2000 + k }));
      data.pullRequests.nodes = [stacked, ...newer, ...data.pullRequests.nodes];
      return data;
    };
    const { items, errors } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(items.find((i) => i.number === 564)).toBeDefined();
    expect(items.find((i) => i.number === 3000)!.stackedOnOpen).toBe(true);
    expect(errors.filter((e) => /closed/.test(e))).toEqual([]);
  });

  it('finds a labelled issue behind 50 newer unlabelled ones, and lists an issue with two turn labels once', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const labelled = data.issues.nodes.find((i: any) => i.number === 563);
      labelled.labels.nodes.push({ name: 'on danyel' });
      const newer = Array.from({ length: 50 }, (_, k) => {
        const copy = structuredClone(labelled);
        copy.number = 4000 + k; copy.labels.nodes = [{ name: 'P2' }];
        return copy;
      });
      data.issues.nodes = [...newer, ...data.issues.nodes];
      return data;
    };
    const { items, errors } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(items.filter((i) => i.number === 563)).toHaveLength(1);
    expect(items.some((i) => i.number >= 4000 && i.number < 4100)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('says so on the page when a list comes back full', async () => {
    const itemsFor = () => {
      const data = recordedRepo();
      const open = data.pullRequests.nodes.find((p: any) => p.number === 564);
      const issue = data.issues.nodes.find((i: any) => i.number === 563);
      for (let k = 0; k < 50; k++) data.pullRequests.nodes.push({ ...structuredClone(open), number: 5000 + k });
      for (let k = 0; k < 51; k++) {
        const copy = structuredClone(issue);
        copy.number = 6000 + k; copy.labels.nodes = [{ name: 'on danyel' }];
        data.issues.nodes.push(copy);
      }
      return data;
    };
    const { errors } = await fetchItems('tok', NOW, fake({ itemsFor }).fn);
    expect(errors).toContain('More than 50 open PRs in danyelf/torahmap; some may be missing from this page');
    expect(errors).toContain('More than 50 open issues labelled "on danyel" in danyelf/torahmap; some may be missing from this page');
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
