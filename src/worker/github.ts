import { DAY_MS, REPO_WINDOW_DAYS, WRITTEN_ELSEWHERE } from '../shared/names.ts';
import { CHECK_STATES, type Facts } from '../shared/facts.ts';
import { message, newest } from '../shared/helpers.ts';
import { itemKey } from '../shared/work.ts';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const REPOS_PER_QUERY = 5;
const MAX_REPOS = 100;
const MAX_COMPARE_CALLS = 20;
const CLOSING_ISSUES_PER_PR = 5;

const REPOS_QUERY = `query {
  viewer {
    repositories(first: ${MAX_REPOS}, ownerAffiliations: [OWNER, COLLABORATOR], orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage }
      nodes { nameWithOwner pushedAt defaultBranchRef { name } }
    }
  }
}`;


interface RepoNode { nameWithOwner: string; pushedAt: string; defaultBranchRef: { name: string } | null }
/** A list as GitHub sends it. Any part of it can be missing or null if GitHub had a problem. */
interface Connection<T> { pageInfo?: { hasNextPage?: boolean; hasPreviousPage?: boolean } | null; nodes?: (T | null)[] | null }
interface GraphqlResponse<T> { data?: T | null; errors?: { message: string; type?: string; path?: (string | number)[] }[] }

type Report = (message: string) => void;

/** The items in a list, without any null entries. Throws if GitHub sent no list at all. */
function listOf<T>(conn: Connection<T> | null | undefined, what: string): { items: T[]; cutOff: boolean } {
  if (!conn || !Array.isArray(conn.nodes)) throw new Error(`GitHub sent no ${what}`);
  return {
    items: conn.nodes.filter((n): n is T => n !== null && n !== undefined),
    cutOff: conn.pageInfo?.hasNextPage === true || conn.pageInfo?.hasPreviousPage === true,
  };
}

/** Like listOf, and says so when the list came back full. */
function listOfItem<T>(
  conn: Connection<T> | null | undefined, field: string, limit: number, where: string, whatIsLost: string, report: Report,
): T[] {
  const { items, cutOff } = listOf(conn, `${field} for ${where}`);
  if (cutOff) report(`More than ${limit} ${field} on ${where}; ${whatIsLost}`);
  return items;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

function headersFor(token: string): Record<string, string> {
  return { Authorization: `bearer ${token}`, 'User-Agent': 'pr-board', 'Content-Type': 'application/json' };
}

/** GitHub answered with an error status. */
export class GitHubRefused extends Error {
  readonly status: number;
  // GitHub's own explanation from the response body, when it gave one.
  readonly githubMessage?: string;
  constructor(status: number, statusText: string, githubMessage?: string) {
    super(`GitHub said ${status} ${statusText}${githubMessage ? `: ${githubMessage}` : ''}`);
    this.status = status;
    this.githubMessage = githubMessage;
  }
}

function graphqlWith(token: string, fetchFn: typeof fetch) {
  return async <T>(query: string, variables?: Record<string, unknown>): Promise<GraphqlResponse<T>> => {
    const res = await fetchFn(GRAPHQL_URL, { method: 'POST', headers: headersFor(token), body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new GitHubRefused(res.status, res.statusText);
    return (await res.json()) as GraphqlResponse<T>;
  };
}

function screenshotsIn(body: string): string[] {
  const urls: string[] = [];
  for (const m of body.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)/g)) urls.push(m[1]);
  for (const m of body.matchAll(/<img\b[^>]*?\bsrc=["']([^"']+)["']/gi)) urls.push(m[1]);
  return urls;
}

/** GitHub's own explanation of a refusal: the message in its JSON, else the start of the body. */
async function refusalMessage(res: Response): Promise<string | undefined> {
  const text = (await res.text().catch(() => '')).trim();
  if (!text) return undefined;
  try {
    const message = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 300);
}

// ---------------------------------------------------------------------------
// What GitHub owns: the PRs and issues themselves, their checks, and their labels.
// ---------------------------------------------------------------------------

const FACT_LABELS = 20;
const FACT_COMMENTS = 20;
const FACT_OPEN_PRS_PER_REPO = 50;

// Comments are read for the preview address only, so only their text is asked for.
const FACT_COMMON_FIELDS = `number title url body createdAt closedAt updatedAt
  labels(first:${FACT_LABELS}){pageInfo{hasNextPage} nodes{name}}
  comments(last:${FACT_COMMENTS}){pageInfo{hasPreviousPage} nodes{author{login} body}}`;

const FACT_PR_FIELDS = `${FACT_COMMON_FIELDS}
  isDraft isCrossRepository merged mergeStateStatus reviewDecision headRefName headRefOid baseRefName
  closingIssuesReferences(first:${CLOSING_ISSUES_PER_PR}){nodes{number repository{nameWithOwner}}}
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}`;

interface FactNode {
  __typename?: string;
  number: number; title: string; url: string; body: string | null; createdAt: string; closedAt: string | null; updatedAt: string;
  labels: Connection<{ name: string }> | null;
  comments: Connection<{ author: { login: string } | null; body: string }> | null;
  isDraft?: boolean; isCrossRepository?: boolean; merged?: boolean; mergeStateStatus?: string | null; reviewDecision?: string | null;
  headRefName?: string; headRefOid?: string; baseRefName?: string;
  closingIssuesReferences?: Connection<{ number: number; repository: { nameWithOwner: string } | null }> | null;
  commits?: Connection<{ commit: { statusCheckRollup: { state: string } | null } | null }> | null;
}

interface FactsPending { facts: Facts; base: string; fromFork: boolean }

/** One PR or issue as the board's facts. Throws if a list GitHub should have sent is missing. */
function factsFrom(repo: string, node: FactNode, isPr: boolean, report: Report): Facts {
  const where = itemKey(repo, node.number);
  const labels = listOfItem(node.labels, 'labels', FACT_LABELS, where, 'a board label may be missing', report).map((l) => l.name);
  const body = node.body ?? '';
  const base = {
    repo, number: node.number, title: node.title, url: node.url, labels,
    createdAt: node.createdAt, closedAt: node.closedAt,
    lastActivityAt: newest([node.createdAt, node.updatedAt, ...(node.closedAt ? [node.closedAt] : [])]),
    screenshots: screenshotsIn(body),
  };
  if (!isPr) {
    return {
      ...base, kind: 'issue', merged: false, isDraft: false, headSha: null, headRef: null, mergeState: null, reviewDecision: null,
      checks: null, behindBase: false, linkedIssue: null, stackedOn: null, stackedOnOpen: false, previewUrl: null,
    };
  }
  const closingRefs = listOf(node.closingIssuesReferences, `closing issues for ${where}`).items;
  const comments = listOf(node.comments, `comments for ${where}`).items;
  const rollup = listOf(node.commits, `commits for ${where}`).items[0]?.commit?.statusCheckRollup?.state ?? null;
  // A closing reference can name an issue in another repo, whose number means nothing here.
  const closing = closingRefs.find((r) => r.repository?.nameWithOwner === repo)?.number;
  const refs = body.match(WRITTEN_ELSEWHERE.refsIssue);
  const stacked = body.match(WRITTEN_ELSEWHERE.stackedOn);
  let previewUrl: string | null = null;
  for (const c of comments) {
    const m = c.body.match(WRITTEN_ELSEWHERE.previewLink);
    if (m) previewUrl = m[1]!;
  }
  return {
    ...base, kind: 'pr', merged: node.merged ?? false, isDraft: node.isDraft ?? false,
    headSha: node.headRefOid ?? null, headRef: node.headRefName ?? null,
    mergeState: node.mergeStateStatus ?? null, reviewDecision: node.reviewDecision ?? null,
    checks: rollup !== null && (CHECK_STATES as readonly string[]).includes(rollup) ? (rollup as Facts['checks']) : null,
    behindBase: false,
    linkedIssue: closing ?? (refs ? Number(refs[1]) : null),
    stackedOn: stacked ? Number(stacked[1]) : null, stackedOnOpen: false,
    previewUrl,
  };
}

/**
 * What GitHub says about PRs and issues. `want` names the repos to read and the numbers to read in each:
 * a repo is read if it was pushed to within REPO_WINDOW_DAYS or is listed. Each repo gives its open PRs,
 * and every listed number is read too, whether it is an issue or a PR, open or closed.
 */
export async function fetchFacts(
  token: string,
  want: { repo: string; numbers: number[] }[],
  now: Date,
  fetchFn: typeof fetch = defaultFetch,
): Promise<{ facts: Facts[]; errors: string[] }> {
  const headers = headersFor(token);
  const errors: string[] = [];
  const graphql = graphqlWith(token, fetchFn);

  try {
    const reposRes = await graphql<{ viewer: { repositories: Connection<RepoNode> } }>(REPOS_QUERY);
    const repoList = reposRes.data?.viewer?.repositories;
    if (!repoList || !Array.isArray(repoList.nodes)) {
      return { facts: [], errors: [reposRes.errors?.[0]?.message ?? 'GitHub sent no repositories'] };
    }
    const nodes = listOf(repoList, 'repositories').items;
    const recent = nodes.filter((r) => now.getTime() - Date.parse(r.pushedAt) <= REPO_WINDOW_DAYS * DAY_MS);
    if (repoList.pageInfo?.hasNextPage && recent.length === nodes.length) {
      errors.push(`More than ${MAX_REPOS} repositories; some recently active ones may be missing`);
    }

    const numbersIn = new Map<string, Set<number>>(recent.map((r) => [r.nameWithOwner, new Set<number>()]));
    for (const w of want) {
      const set = numbersIn.get(w.repo) ?? new Set<number>();
      for (const n of w.numbers) set.add(n);
      numbersIn.set(w.repo, set);
    }
    const repos = [...numbersIn.keys()];

    const pending = new Map<string, FactsPending>();
    const openByRepo = new Map<string, Set<number>>();
    for (let i = 0; i < repos.length; i += REPOS_PER_QUERY) {
      const batch = repos.slice(i, i + REPOS_PER_QUERY);
      const aliases = batch.map((name, k) => {
        const [owner, repo] = name.split('/');
        const listed = [...numbersIn.get(name)!].map((n) =>
          `  i${n}: issueOrPullRequest(number: ${n}) { __typename ... on PullRequest { ${FACT_PR_FIELDS} } ... on Issue { ${FACT_COMMON_FIELDS} } }`);
        return `r${k}: repository(owner: "${owner}", name: "${repo}") {
  openPrs: pullRequests(first: ${FACT_OPEN_PRS_PER_REPO}, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { pageInfo { hasNextPage } nodes { ${FACT_PR_FIELDS} } }
${listed.join('\n')}
}`;
      });
      const res = await graphql<Record<string, Record<string, unknown> | null>>(`query {\n${aliases.join('\n')}\n}`);
      const failed = new Map<string, string>();
      for (const err of res.errors ?? []) {
        const alias = err.path?.[0];
        const name = typeof alias === 'string' && /^r\d+$/.test(alias) ? batch[Number(alias.slice(1))] : undefined;
        const item = err.path?.[1];
        if (name && typeof item === 'string' && /^i\d+$/.test(item)) errors.push(`Couldn't read ${name}#${item.slice(1)}: ${err.message}`);
        else if (name) { if (!failed.has(name)) failed.set(name, err.message); }
        else errors.push(`GitHub said: ${err.message}`);
      }
      for (const [name, message] of failed) errors.push(`Couldn't read ${name}: ${message}`);
      batch.forEach((name, k) => {
        const data = res.data?.[`r${k}`];
        if (!data) return;
        // A repo whose data is incomplete is left out whole, with a line saying so, rather than half shown.
        const repoErrors: string[] = [];
        const report: Report = (m) => repoErrors.push(m);
        try {
          const found: FactsPending[] = [];
          const prs = listOf(data.openPrs as Connection<FactNode> | null, 'list of open PRs');
          if (prs.cutOff) report(`More than ${FACT_OPEN_PRS_PER_REPO} open PRs in ${name}; some may be missing from this page`);
          const open = new Set<number>();
          for (const pr of prs.items) {
            open.add(pr.number);
            found.push({ facts: factsFrom(name, pr, true, report), base: pr.baseRefName ?? '', fromFork: pr.isCrossRepository === true });
          }
          for (const [key, value] of Object.entries(data)) {
            const node = value as FactNode | null;
            if (!/^i\d+$/.test(key) || !node) continue;
            const isPr = node.__typename === 'PullRequest';
            found.push({ facts: factsFrom(name, node, isPr, report), base: node.baseRefName ?? '', fromFork: node.isCrossRepository === true });
          }
          openByRepo.set(name, open);
          for (const p of found) {
            const key = itemKey(name, p.facts.number);
            if (!pending.has(key)) pending.set(key, p);
          }
          errors.push(...repoErrors);
        } catch (e) {
          errors.push(`Couldn't read ${name}: ${message(e)}`);
        }
      });
    }

    const all = [...pending.values()];
    for (const { facts } of all) {
      if (facts.stackedOn !== null) facts.stackedOnOpen = openByRepo.get(facts.repo)?.has(facts.stackedOn) ?? false;
    }

    // Only so many PRs can be compared with their base. PRs from forks are skipped, since their branches aren't in this repo.
    const open = all.filter((p) => p.facts.kind === 'pr' && p.facts.closedAt === null && !p.fromFork);
    const toCheck = open.slice(0, MAX_COMPARE_CALLS);
    await Promise.all(toCheck.map(async (p) => {
      const range = `${p.base}...${p.facts.headRef ?? ''}`.split('/').map(encodeURIComponent).join('/');
      try {
        const res = await fetchFn(`https://api.github.com/repos/${p.facts.repo}/compare/${range}`, { headers });
        if (!res.ok) { errors.push(`Couldn't compare ${p.facts.repo}#${p.facts.number} with ${p.base}`); return; }
        const body = (await res.json()) as { behind_by?: number };
        p.facts.behindBase = (body.behind_by ?? 0) > 0;
      } catch {
        errors.push(`Couldn't compare ${p.facts.repo}#${p.facts.number} with ${p.base}`);
      }
    }));
    if (open.length > toCheck.length) errors.push(`Didn't check ${open.length - toCheck.length} PRs against their base branch`);

    return { facts: all.map((p) => p.facts), errors };
  } catch (e) {
    if (e instanceof GitHubRefused) return { facts: [], errors: [e.message] };
    throw e;
  }
}

/**
 * Adds and removes labels on a PR or issue. Removing a label the item doesn't have is not an error.
 * Throws if GitHub refuses anything else.
 */
export async function setLabels(
  token: string, f: Facts, add: string[], remove: string[], fetchFn: typeof fetch = defaultFetch,
): Promise<void> {
  const base = `https://api.github.com/repos/${f.repo.split('/').map(encodeURIComponent).join('/')}/issues/${f.number}/labels`;
  if (add.length > 0) {
    const res = await fetchFn(base, { method: 'POST', headers: headersFor(token), body: JSON.stringify({ labels: add }) });
    if (!res.ok) throw new GitHubRefused(res.status, res.statusText, await refusalMessage(res));
  }
  for (const label of remove) {
    const res = await fetchFn(`${base}/${encodeURIComponent(label)}`, { method: 'DELETE', headers: headersFor(token) });
    if (!res.ok && res.status !== 404) throw new GitHubRefused(res.status, res.statusText, await refusalMessage(res));
  }
}
