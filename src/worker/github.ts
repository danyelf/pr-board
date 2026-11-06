import type { ItemFacts, LabelEvent } from '../shared/types.ts';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const REPO_WINDOW_DAYS = 60;
const REPOS_PER_QUERY = 5;
const MAX_COMPARE_CALLS = 20;
const OPEN_PRS_PER_REPO = 50;
const ISSUES_PER_LABEL = 50;
// One issues connection per label, so GitHub does the filtering and each label has its own limit.
const TURN_LABELS = [
  { label: 'on danyel', alias: 'onDanyel' },
  { label: 'parked', alias: 'parked' },
  { label: 'in-progress', alias: 'inProgress' },
] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const REPOS_QUERY = `query {
  viewer {
    repositories(first: 100, ownerAffiliations: [OWNER, COLLABORATOR], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { nameWithOwner pushedAt defaultBranchRef { name } }
    }
  }
}`;

const COMMON_FIELDS = `number title url body createdAt updatedAt closedAt
  labels(first:20){nodes{name}}
  comments(last:100){nodes{author{login} body url createdAt updatedAt}}
  timelineItems(last:100, itemTypes:[LABELED_EVENT, UNLABELED_EVENT]){nodes{__typename ... on LabeledEvent{label{name} createdAt} ... on UnlabeledEvent{label{name} createdAt}}}`;

const PR_FIELDS = `${COMMON_FIELDS}
  isDraft merged mergedAt mergeStateStatus headRefName baseRefName
  closingIssuesReferences(first:1){nodes{number}}
  files(first:100){nodes{path changeType}}
  commits(last:100){nodes{commit{oid committedDate}}}`;

interface RepoNode { nameWithOwner: string; pushedAt: string; defaultBranchRef: { name: string } | null }
interface Comment { author: { login: string } | null; body: string; url: string; createdAt: string; updatedAt: string }
interface TimelineNode { __typename: string; label?: { name: string }; createdAt?: string }
interface RawItem {
  number: number; title: string; url: string; body: string; createdAt: string; updatedAt?: string; closedAt: string | null;
  labels: { nodes: { name: string }[] };
  comments: { nodes: Comment[] };
  timelineItems: { nodes: TimelineNode[] };
  isDraft?: boolean; merged?: boolean; mergedAt?: string | null; mergeStateStatus?: string | null;
  headRefName?: string; baseRefName?: string;
  closingIssuesReferences?: { nodes: { number: number }[] };
  files?: { nodes: { path: string; changeType: string }[] };
  commits?: { nodes: { commit: { oid: string; committedDate: string } }[] };
}
interface Page { pageInfo: { hasNextPage: boolean }; nodes: RawItem[] }
interface RepoData { openPrs: Page; onDanyel: Page; parked: Page; inProgress: Page }
interface GraphqlResponse<T> { data?: T | null; errors?: { message: string; path?: (string | number)[] }[] }

interface Pending { facts: ItemFacts; base: string; head: string }

export async function fetchItems(
  token: string,
  now: Date,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ items: ItemFacts[]; errors: string[] }> {
  const headers = { Authorization: `bearer ${token}`, 'User-Agent': 'pr-board', 'Content-Type': 'application/json' };
  const errors: string[] = [];

  async function graphql<T>(query: string): Promise<GraphqlResponse<T>> {
    const res = await fetchFn(GRAPHQL_URL, { method: 'POST', headers, body: JSON.stringify({ query }) });
    if (!res.ok) throw new HttpError(`GitHub said ${res.status} ${res.statusText}`);
    return (await res.json()) as GraphqlResponse<T>;
  }

  try {
    const reposRes = await graphql<{ viewer: { repositories: { nodes: RepoNode[] } } }>(REPOS_QUERY);
    const nodes = reposRes.data?.viewer.repositories.nodes;
    if (!nodes) return { items: [], errors: [reposRes.errors?.[0]?.message ?? 'GitHub sent no repositories'] };
    const recent = nodes.filter((r) => now.getTime() - Date.parse(r.pushedAt) <= REPO_WINDOW_DAYS * DAY_MS);

    const pending: Pending[] = [];
    const openByRepo = new Map<string, Set<number>>();
    for (let i = 0; i < recent.length; i += REPOS_PER_QUERY) {
      const batch = recent.slice(i, i + REPOS_PER_QUERY);
      const aliases = batch.map((repo, k) => {
        const [owner, name] = repo.nameWithOwner.split('/');
        const issues = TURN_LABELS.map(({ label, alias }) =>
          `  ${alias}: issues(first: ${ISSUES_PER_LABEL}, states: OPEN, labels: ["${label}"], orderBy: {field: UPDATED_AT, direction: DESC}) { pageInfo { hasNextPage } nodes { ${COMMON_FIELDS} } }`);
        return `r${k}: repository(owner: "${owner}", name: "${name}") {
  openPrs: pullRequests(first: ${OPEN_PRS_PER_REPO}, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { pageInfo { hasNextPage } nodes { ${PR_FIELDS} } }
${issues.join('\n')}
}`;
      });
      const res = await graphql<Record<string, RepoData | null>>(`query {\n${aliases.join('\n')}\n}`);
      const failed = new Map<string, string>();
      for (const err of res.errors ?? []) {
        const alias = err.path?.[0];
        const repo = typeof alias === 'string' && /^r\d+$/.test(alias) ? batch[Number(alias.slice(1))] : undefined;
        if (repo) { if (!failed.has(repo.nameWithOwner)) failed.set(repo.nameWithOwner, err.message); }
        else errors.push(`GitHub said: ${err.message}`);
      }
      for (const [name, message] of failed) errors.push(`Couldn't read ${name}: ${message}`);
      batch.forEach((repo, k) => {
        const data = res.data?.[`r${k}`];
        if (!data) return;
        const name = repo.nameWithOwner;
        const open = new Set<number>();
        openByRepo.set(name, open);

        if (data.openPrs.pageInfo.hasNextPage) {
          errors.push(`More than ${OPEN_PRS_PER_REPO} open PRs in ${name}; some may be missing from this page`);
        }
        for (const pr of data.openPrs.nodes) {
          open.add(pr.number);
          pending.push({ facts: prFacts(name, pr), base: pr.baseRefName ?? '', head: pr.headRefName ?? '' });
        }

        const seenIssues = new Set<number>();
        for (const { label, alias } of TURN_LABELS) {
          const page = data[alias];
          if (page.pageInfo.hasNextPage) {
            errors.push(`More than ${ISSUES_PER_LABEL} open issues labelled "${label}" in ${name}; some may be missing from this page`);
          }
          for (const issue of page.nodes) {
            if (seenIssues.has(issue.number)) continue;
            seenIssues.add(issue.number);
            pending.push({ facts: issueFacts(name, issue), base: '', head: '' });
          }
        }
      });
    }

    for (const { facts } of pending) {
      if (facts.stackedOn !== null) facts.stackedOnOpen = openByRepo.get(facts.repo)?.has(facts.stackedOn) ?? false;
    }

    const open = pending.filter((p) => p.facts.kind === 'pr' && p.facts.closedAt === null);
    const toCheck = open.slice(0, MAX_COMPARE_CALLS);
    await Promise.all(toCheck.map(async (p) => {
      const range = `${p.base}...${p.head}`.split('/').map(encodeURIComponent).join('/');
      try {
        const res = await fetchFn(`https://api.github.com/repos/${p.facts.repo}/compare/${range}`, { headers });
        if (!res.ok) { errors.push(`Couldn't compare ${p.facts.repo}#${p.facts.number} with ${p.base}`); return; }
        const body = (await res.json()) as { behind_by?: number };
        p.facts.behindBase = (body.behind_by ?? 0) > 0;
      } catch {
        errors.push(`Couldn't compare ${p.facts.repo}#${p.facts.number} with ${p.base}`);
      }
    }));
    if (open.length > toCheck.length) errors.push(`Didn't check ${open.length - toCheck.length} PRs against main`);

    return { items: pending.map((p) => p.facts), errors };
  } catch (e) {
    if (e instanceof HttpError) return { items: [], errors: [e.message] };
    throw e;
  }
}

class HttpError extends Error {}

function labelEvents(item: RawItem): LabelEvent[] {
  const events: LabelEvent[] = [];
  for (const n of item.timelineItems.nodes) {
    if (!n.label || !n.createdAt) continue;
    events.push({ label: n.label.name, action: n.__typename === 'LabeledEvent' ? 'added' : 'removed', at: n.createdAt });
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function latest(times: string[]): string {
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

function screenshotsIn(body: string): string[] {
  const urls: string[] = [];
  for (const m of body.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)/g)) urls.push(m[1]);
  for (const m of body.matchAll(/<img\b[^>]*?\bsrc=["']([^"']+)["']/gi)) urls.push(m[1]);
  return urls;
}

function baseFacts(repo: string, item: RawItem, kind: 'pr' | 'issue', events: LabelEvent[], extraTimes: string[]) {
  const times = [
    item.createdAt, ...(item.closedAt ? [item.closedAt] : []), ...extraTimes,
    ...item.comments.nodes.map((c) => c.createdAt), ...events.map((e) => e.at),
  ];
  return {
    repo, number: item.number, kind, title: item.title, url: item.url,
    labels: item.labels.nodes.map((l) => l.name), body: item.body ?? '',
    createdAt: item.createdAt, closedAt: item.closedAt,
    labelEvents: events, lastActivityAt: latest(times),
  };
}

function prFacts(repo: string, pr: RawItem): ItemFacts {
  const events = labelEvents(pr);
  const commits = (pr.commits?.nodes ?? []).map((n) => n.commit);
  const comments = pr.comments.nodes;
  const body = pr.body ?? '';

  const closing = pr.closingIssuesReferences?.nodes[0]?.number;
  const refs = body.match(/Refs #(\d+)/);
  const stacked = body.match(/Stacked on #(\d+)/i);

  let previewUrl: string | null = null;
  for (const c of comments) {
    const m = c.body.match(/href='(https:\/\/[^']+)'>Branch Preview URL/);
    if (m) previewUrl = m[1];
  }

  let reviewSha: string | null = null;
  let reviewUrl: string | null = null;
  for (const c of comments) {
    const m = c.body.match(/Reviewed up to `([0-9a-f]{7,40})`/);
    if (m) { reviewSha = m[1]; reviewUrl = c.url; }
  }
  let commitsSinceReview: number | null = null;
  if (reviewSha) {
    const idx = commits.findIndex((c) => c.oid.startsWith(reviewSha!));
    if (idx >= 0) commitsSinceReview = commits.length - 1 - idx;
  }

  let prepAt: string | null = null;
  for (const c of comments) if (c.body.includes('🤖 Claude: prep for merge')) prepAt = c.createdAt;
  const commitsSincePrep = prepAt === null ? null : commits.filter((c) => Date.parse(c.committedDate) > Date.parse(prepAt!)).length;

  const extra = [...(pr.mergedAt ? [pr.mergedAt] : []), ...commits.map((c) => c.committedDate)];
  return {
    ...baseFacts(repo, pr, 'pr', events, extra),
    isDraft: pr.isDraft ?? false, merged: pr.merged ?? false, mergedAt: pr.mergedAt ?? null,
    mergeState: pr.mergeStateStatus ?? null, behindBase: false,
    linkedIssue: closing ?? (refs ? Number(refs[1]) : null),
    stackedOn: stacked ? Number(stacked[1]) : null, stackedOnOpen: false,
    previewUrl,
    addedDocs: (pr.files?.nodes ?? [])
      .filter((f) => f.changeType === 'ADDED' && f.path.endsWith('.md') && f.path.startsWith('docs/'))
      .map((f) => ({ path: f.path, url: `${pr.url}/files` })),
    screenshots: screenshotsIn(body),
    reviewSha, reviewUrl, commitsSinceReview,
    prepDone: prepAt !== null, commitsSincePrep,
    statusCommentBody: null,
  };
}

function issueFacts(repo: string, issue: RawItem): ItemFacts {
  const events = labelEvents(issue);
  let statusCommentBody: string | null = null;
  for (const c of issue.comments.nodes) if (c.body.includes('<!-- status -->')) statusCommentBody = c.body;
  return {
    ...baseFacts(repo, issue, 'issue', events, []),
    isDraft: false, merged: false, mergedAt: null, mergeState: null, behindBase: false,
    linkedIssue: null, stackedOn: null, stackedOnOpen: false,
    previewUrl: null, addedDocs: [], screenshots: screenshotsIn(issue.body ?? ''),
    reviewSha: null, reviewUrl: null, commitsSinceReview: null,
    prepDone: false, commitsSincePrep: null,
    statusCommentBody,
  };
}
