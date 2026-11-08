import { answersCurrentStatus, isClaimReaction, isOwnerAnswer } from '../shared/answer.ts';
import { DAY_MS, LABEL_IN_PROGRESS, LABEL_ON_OWNER, LABEL_PARKED, REPO_WINDOW_DAYS, WRITTEN_ELSEWHERE } from '../shared/names.ts';
import { parseStatus, pickStatusComment } from '../shared/status.ts';
import { effectiveTurn } from '../shared/turn.ts';
import type { AnswerSeen, ItemFacts, LabelEvent } from '../shared/types.ts';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const REPOS_PER_QUERY = 5;
const MAX_REPOS = 100;
const MAX_COMPARE_CALLS = 20;
const OPEN_PRS_PER_REPO = 50;
const ISSUES_PER_LABEL = 50;
const LABELS_PER_ITEM = 20;
const COMMENTS_PER_ITEM = 100;
const LABEL_CHANGES_PER_ITEM = 100;
const FILES_PER_PR = 100;
const COMMITS_PER_PR = 100;
const CLOSING_ISSUES_PER_PR = 5;
// Answers waiting to be picked up are few: an item's answers drop out once Claude rewrites its status.
const MAX_ANSWERS_CHECKED = 100;
const CLAIMS_PER_ANSWER = 20;
// One issues connection per label, so GitHub does the filtering and each label has its own limit.
const TURN_LABELS = [
  { label: LABEL_ON_OWNER, alias: 'onOwner' },
  { label: LABEL_PARKED, alias: 'parked' },
  { label: LABEL_IN_PROGRESS, alias: 'inProgress' },
] as const;

const REPOS_QUERY = `query {
  viewer {
    repositories(first: ${MAX_REPOS}, ownerAffiliations: [OWNER, COLLABORATOR], orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage }
      nodes { nameWithOwner pushedAt defaultBranchRef { name } }
    }
  }
}`;

// For connections read from the start (first:) ask hasNextPage; for ones read from the end (last:) ask hasPreviousPage.
const COMMON_FIELDS = `number title url body createdAt closedAt
  labels(first:${LABELS_PER_ITEM}){pageInfo{hasNextPage} nodes{name}}
  comments(last:${COMMENTS_PER_ITEM}){pageInfo{hasPreviousPage} nodes{id author{login} body url createdAt updatedAt}}
  timelineItems(last:${LABEL_CHANGES_PER_ITEM}, itemTypes:[LABELED_EVENT, UNLABELED_EVENT]){pageInfo{hasPreviousPage} nodes{__typename ... on LabeledEvent{label{name} createdAt} ... on UnlabeledEvent{label{name} createdAt}}}`;

const PR_FIELDS = `${COMMON_FIELDS}
  isDraft isCrossRepository merged mergedAt lastEditedAt mergeStateStatus headRefName baseRefName
  closingIssuesReferences(first:${CLOSING_ISSUES_PER_PR}){nodes{number repository{nameWithOwner}}}
  files(first:${FILES_PER_PR}){pageInfo{hasNextPage} nodes{path changeType}}
  commits(last:${COMMITS_PER_PR}){pageInfo{hasPreviousPage} nodes{commit{oid committedDate}}}`;

interface RepoNode { nameWithOwner: string; pushedAt: string; defaultBranchRef: { name: string } | null }
interface Comment { id?: string; author: { login: string } | null; body: string; url: string; createdAt: string; updatedAt: string }
interface TimelineNode { __typename: string; label?: { name: string }; createdAt?: string }
/** A list as GitHub sends it. Any part of it can be missing or null if GitHub had a problem. */
interface Connection<T> { pageInfo?: { hasNextPage?: boolean; hasPreviousPage?: boolean } | null; nodes?: (T | null)[] | null }
interface RawItem {
  number: number; title: string; url: string; body: string | null; createdAt: string; closedAt: string | null;
  labels: Connection<{ name: string }> | null;
  comments: Connection<Comment> | null;
  timelineItems: Connection<TimelineNode> | null;
  isDraft?: boolean; isCrossRepository?: boolean; merged?: boolean; mergedAt?: string | null; lastEditedAt?: string | null;
  mergeStateStatus?: string | null;
  headRefName?: string; baseRefName?: string;
  closingIssuesReferences?: Connection<{ number: number; repository: { nameWithOwner: string } | null }> | null;
  files?: Connection<{ path: string; changeType: string }> | null;
  commits?: Connection<{ commit: { oid: string; committedDate: string } }> | null;
}
interface RepoData {
  openPrs: Connection<RawItem> | null;
  onOwner: Connection<RawItem> | null;
  parked: Connection<RawItem> | null;
  inProgress: Connection<RawItem> | null;
}
interface GraphqlResponse<T> { data?: T | null; errors?: { message: string; path?: (string | number)[] }[] }

interface Pending {
  facts: ItemFacts; base: string; head: string;
  fromFork: boolean;
  /** Prep is done and it is the owner's turn, so this PR could be one they are about to merge. */
  couldBeReady: boolean;
}

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

function graphqlWith(token: string, fetchFn: typeof fetch) {
  return async <T>(query: string, variables?: Record<string, unknown>): Promise<GraphqlResponse<T>> => {
    const res = await fetchFn(GRAPHQL_URL, { method: 'POST', headers: headersFor(token), body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new HttpError(`GitHub said ${res.status} ${res.statusText}`);
    return (await res.json()) as GraphqlResponse<T>;
  };
}

const CLAIMS_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on IssueComment { id reactions(content: EYES, first: ${CLAIMS_PER_ANSWER}) { nodes { content createdAt user { login } } } } }
}`;

/**
 * Marks when each answer was claimed: the first 👀 from someone other than the owner (a watcher).
 * Only the answers the board found are asked about, by id, so the main query stays the size it was.
 */
async function readClaims(answers: AnswerSeen[], graphql: ReturnType<typeof graphqlWith>, errors: string[]): Promise<void> {
  if (answers.length === 0) return;
  const asked = answers.slice(0, MAX_ANSWERS_CHECKED);
  if (answers.length > asked.length) errors.push(`More than ${MAX_ANSWERS_CHECKED} answers to check; some may show as not picked up`);
  type Reaction = { content?: string; createdAt?: string; user: { login: string } | null };
  type Node = { id?: string; reactions?: { nodes?: (Reaction | null)[] | null } | null } | null;
  try {
    const res = await graphql<{ nodes: Node[] | null }>(CLAIMS_QUERY, { ids: asked.map((a) => a.id) });
    const nodes = res.data?.nodes;
    if (!Array.isArray(nodes)) {
      errors.push(`Couldn't check whether answers were picked up: ${res.errors?.[0]?.message ?? 'GitHub sent nothing'}`);
      return;
    }
    const claimedAt = new Map<string, string>();
    for (const n of nodes) {
      const claims = (n?.reactions?.nodes ?? [])
        .filter((r): r is Reaction => r !== null && isClaimReaction(r.user?.login, r.content ?? '') && typeof r.createdAt === 'string')
        .map((r) => r.createdAt!);
      if (n?.id && claims.length > 0) claimedAt.set(n.id, earliest(claims));
    }
    for (const a of asked) a.claimedAt = claimedAt.get(a.id) ?? null;
  } catch (e) {
    errors.push(`Couldn't check whether answers were picked up: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function fetchItems(
  token: string,
  now: Date,
  fetchFn: typeof fetch = defaultFetch,
): Promise<{ items: ItemFacts[]; errors: string[] }> {
  const headers = headersFor(token);
  const errors: string[] = [];
  const graphql = graphqlWith(token, fetchFn);

  try {
    const reposRes = await graphql<{ viewer: { repositories: Connection<RepoNode> } }>(REPOS_QUERY);
    const repoList = reposRes.data?.viewer?.repositories;
    if (!repoList || !Array.isArray(repoList.nodes)) {
      return { items: [], errors: [reposRes.errors?.[0]?.message ?? 'GitHub sent no repositories'] };
    }
    const nodes = listOf(repoList, 'repositories').items;
    const recent = nodes.filter((r) => now.getTime() - Date.parse(r.pushedAt) <= REPO_WINDOW_DAYS * DAY_MS);
    // Newest push first, so more repos only matter if the last one we got is still inside the window.
    if (repoList.pageInfo?.hasNextPage && recent.length === nodes.length) {
      errors.push(`More than ${MAX_REPOS} repositories; some recently active ones may be missing`);
    }

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
        // A repo whose data is incomplete is left out whole, with a line saying so, rather than half shown.
        const repoErrors: string[] = [];
        try {
          const read = readRepo(name, data, (m) => repoErrors.push(m));
          openByRepo.set(name, read.open);
          pending.push(...read.pending);
          errors.push(...repoErrors);
        } catch (e) {
          errors.push(`Couldn't read ${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    }

    for (const { facts } of pending) {
      if (facts.stackedOn !== null) facts.stackedOnOpen = openByRepo.get(facts.repo)?.has(facts.stackedOn) ?? false;
    }
    await readClaims(pending.flatMap((p) => p.facts.answers), graphql, errors);

    // Only so many PRs can be compared with their base. Those that could be about to merge come first,
    // and PRs from forks are skipped, since their branches aren't in this repo to compare.
    const open = pending.filter((p) => p.facts.kind === 'pr' && p.facts.closedAt === null && !p.fromFork);
    const ordered = [...open.filter((p) => p.couldBeReady), ...open.filter((p) => !p.couldBeReady)];
    const toCheck = ordered.slice(0, MAX_COMPARE_CALLS);
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
    if (open.length > toCheck.length) errors.push(`Didn't check ${open.length - toCheck.length} PRs against their base branch`);

    return { items: pending.map((p) => p.facts), errors };
  } catch (e) {
    if (e instanceof HttpError) return { items: [], errors: [e.message] };
    throw e;
  }
}

class HttpError extends Error {}

/** Everything wanted from one repo's answer. Throws if a list GitHub should have sent is missing. */
function readRepo(name: string, data: RepoData, report: Report): { open: Set<number>; pending: Pending[] } {
  const open = new Set<number>();
  const pending: Pending[] = [];

  const prs = listOf(data.openPrs, 'list of open PRs');
  if (prs.cutOff) report(`More than ${OPEN_PRS_PER_REPO} open PRs in ${name}; some may be missing from this page`);
  for (const pr of prs.items) {
    open.add(pr.number);
    const facts = prFacts(name, pr, report);
    const turn = effectiveTurn(facts.labels, parseStatus(facts.body)).turn;
    pending.push({
      facts, base: pr.baseRefName ?? '', head: pr.headRefName ?? '',
      fromFork: pr.isCrossRepository === true,
      couldBeReady: facts.prepDone && turn === 'owner',
    });
  }

  const seenIssues = new Set<number>();
  for (const { label, alias } of TURN_LABELS) {
    const page = listOf(data[alias], `list of issues labelled "${label}"`);
    if (page.cutOff) {
      report(`More than ${ISSUES_PER_LABEL} open issues labelled "${label}" in ${name}; some may be missing from this page`);
    }
    for (const issue of page.items) {
      if (seenIssues.has(issue.number)) continue;
      seenIssues.add(issue.number);
      pending.push({ facts: issueFacts(name, issue, report), base: '', head: '', fromFork: false, couldBeReady: false });
    }
  }
  return { open, pending };
}

function labelEvents(item: RawItem, where: string, report: Report): LabelEvent[] {
  const nodes = listOfItem(item.timelineItems, 'label changes', LABEL_CHANGES_PER_ITEM, where, 'how long it has waited may be wrong', report);
  const events: LabelEvent[] = [];
  for (const n of nodes) {
    if (!n.label || !n.createdAt) continue;
    events.push({ label: n.label.name, action: n.__typename === 'LabeledEvent' ? 'added' : 'removed', at: n.createdAt });
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function latest(times: string[]): string {
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

function earliest(times: string[]): string {
  return times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}

function latestOrNull(times: string[]): string | null {
  return times.length > 0 ? latest(times) : null;
}

function screenshotsIn(body: string): string[] {
  const urls: string[] = [];
  for (const m of body.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)/g)) urls.push(m[1]);
  for (const m of body.matchAll(/<img\b[^>]*?\bsrc=["']([^"']+)["']/gi)) urls.push(m[1]);
  return urls;
}

function baseFacts(repo: string, item: RawItem, kind: 'pr' | 'issue', labels: string[], events: LabelEvent[], comments: Comment[], extraTimes: string[]) {
  const times = [
    item.createdAt, ...(item.closedAt ? [item.closedAt] : []), ...extraTimes,
    ...comments.map((c) => c.createdAt), ...events.map((e) => e.at),
  ];
  return {
    repo, number: item.number, kind, title: item.title, url: item.url,
    labels, body: item.body ?? '',
    createdAt: item.createdAt, closedAt: item.closedAt,
    labelEvents: events, lastActivityAt: latest(times),
  };
}

const fromOwner = (c: Comment): boolean => isOwnerAnswer(c.author?.login, c.body);

/** The owner's answers to the current status, oldest first. Whether each was claimed is read afterwards. */
function answersSince(comments: Comment[], writtenAt: string | null): AnswerSeen[] {
  return comments
    .filter((c): c is Comment & { id: string } =>
      c.id !== undefined && answersCurrentStatus({ login: c.author?.login, body: c.body, createdAt: c.createdAt }, writtenAt))
    .map((c) => ({ id: c.id, url: c.url, at: c.createdAt, claimedAt: null }));
}

function prFacts(repo: string, pr: RawItem, report: Report): ItemFacts {
  const where = `${repo}#${pr.number}`;
  const events = labelEvents(pr, where, report);
  const commits = listOfItem(pr.commits, 'commits', COMMITS_PER_PR, where, 'commit counts may be off', report).map((n) => n.commit);
  const comments = listOfItem(pr.comments, 'comments', COMMENTS_PER_ITEM, where, 'a review, prep note or answer may be missing', report);
  const files = listOfItem(pr.files, 'files', FILES_PER_PR, where, 'an added design doc may be missing', report);
  const closingRefs = listOf(pr.closingIssuesReferences, `closing issues for ${where}`).items;
  const labels = listOfItem(pr.labels, 'labels', LABELS_PER_ITEM, where, 'a turn label may be missing', report).map((l) => l.name);
  const body = pr.body ?? '';

  // A closing reference can name an issue in another repo, whose number means nothing here.
  const closing = closingRefs.find((r) => r.repository?.nameWithOwner === repo)?.number;
  const refs = body.match(WRITTEN_ELSEWHERE.refsIssue);
  const stacked = body.match(WRITTEN_ELSEWHERE.stackedOn);

  let previewUrl: string | null = null;
  for (const c of comments) {
    const m = c.body.match(WRITTEN_ELSEWHERE.previewLink);
    if (m) previewUrl = m[1];
  }

  let reviewSha: string | null = null;
  let reviewUrl: string | null = null;
  for (const c of comments) {
    const m = c.body.match(WRITTEN_ELSEWHERE.reviewedUpTo);
    if (m) { reviewSha = m[1]; reviewUrl = c.url; }
  }
  // Stays null when the reviewed commit isn't among the PR's commits (the PR was rebased or force-pushed).
  let commitsSinceReview: number | null = null;
  if (reviewSha) {
    const idx = commits.findIndex((c) => c.oid.startsWith(reviewSha!));
    if (idx >= 0) commitsSinceReview = commits.length - 1 - idx;
  }

  let prepAt: string | null = null;
  for (const c of comments) if (c.body.includes(WRITTEN_ELSEWHERE.prepForMerge)) prepAt = c.createdAt;
  const commitsSincePrep = prepAt === null ? null : commits.filter((c) => Date.parse(c.committedDate) > Date.parse(prepAt!)).length;

  const extra = [...(pr.mergedAt ? [pr.mergedAt] : []), ...commits.map((c) => c.committedDate)];
  // The time pr-status wrote into the status, while the text still matches it; else the description's last edit.
  const statusWrittenAt = parseStatus(body)?.writtenAt ?? pr.lastEditedAt ?? pr.createdAt;
  return {
    ...baseFacts(repo, pr, 'pr', labels, events, comments, extra),
    isDraft: pr.isDraft ?? false, merged: pr.merged ?? false, mergedAt: pr.mergedAt ?? null,
    mergeState: pr.mergeStateStatus ?? null, behindBase: false,
    linkedIssue: closing ?? (refs ? Number(refs[1]) : null),
    stackedOn: stacked ? Number(stacked[1]) : null, stackedOnOpen: false,
    previewUrl,
    addedDocs: files
      .filter((f) => f.changeType === 'ADDED' && f.path.endsWith('.md') && f.path.startsWith('docs/'))
      .map((f) => ({ path: f.path, url: `${pr.url}/files` })),
    screenshots: screenshotsIn(body),
    reviewSha, reviewUrl, commitsSinceReview,
    prepDone: prepAt !== null, commitsSincePrep,
    statusCommentBody: null,
    statusWrittenAt,
    answers: answersSince(comments, statusWrittenAt),
    // The owner answering is not a change the status should have caught up with.
    lastChangeAt: latestOrNull([...commits.map((c) => c.committedDate), ...comments.filter((c) => !fromOwner(c)).map((c) => c.createdAt)]),
  };
}

function issueFacts(repo: string, issue: RawItem, report: Report): ItemFacts {
  const where = `${repo}#${issue.number}`;
  const events = labelEvents(issue, where, report);
  const comments = listOfItem(issue.comments, 'comments', COMMENTS_PER_ITEM, where, 'the status comment or an answer may be missing', report);
  const labels = listOfItem(issue.labels, 'labels', LABELS_PER_ITEM, where, 'a turn label may be missing', report).map((l) => l.name);
  const statusComment = pickStatusComment(comments);
  const statusWrittenAt = statusComment ? parseStatus(statusComment.body)?.writtenAt ?? statusComment.updatedAt : null;
  return {
    ...baseFacts(repo, issue, 'issue', labels, events, comments, []),
    isDraft: false, merged: false, mergedAt: null, mergeState: null, behindBase: false,
    linkedIssue: null, stackedOn: null, stackedOnOpen: false,
    previewUrl: null, addedDocs: [], screenshots: screenshotsIn(issue.body ?? ''),
    reviewSha: null, reviewUrl: null, commitsSinceReview: null,
    prepDone: false, commitsSincePrep: null,
    statusCommentBody: statusComment?.body ?? null,
    statusWrittenAt,
    answers: answersSince(comments, statusWrittenAt),
    lastChangeAt: latestOrNull(comments.filter((c) => c !== statusComment && !fromOwner(c)).map((c) => c.createdAt)),
  };
}

/** Posts a comment on a PR or issue, and says which account it went up under. Throws if GitHub refuses. */
/** GitHub answered a write with an error status. */
export class GitHubRefused extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`GitHub said ${status} ${statusText}`);
    this.status = status;
  }
}

export async function postComment(
  token: string, repo: string, n: number, body: string, fetchFn: typeof fetch = defaultFetch,
): Promise<{ login: string | null }> {
  const path = repo.split('/').map(encodeURIComponent).join('/');
  const res = await fetchFn(`https://api.github.com/repos/${path}/issues/${n}/comments`, {
    method: 'POST', headers: headersFor(token), body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new GitHubRefused(res.status, res.statusText);
  const posted = (await res.json()) as { user?: { login?: string } | null };
  return { login: posted.user?.login ?? null };
}

const ITEM_QUERY = `query($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) {
    issueOrPullRequest(number: $n) { __typename ... on PullRequest { ${PR_FIELDS} } ... on Issue { ${COMMON_FIELDS} } }
  }
}`;

/**
 * One PR or issue, read the way the board reads it, or null when the token can't see it. For checking
 * an item just before acting on it. Whether its answers have been picked up is not read.
 */
export async function fetchItem(token: string, repo: string, n: number, fetchFn: typeof fetch = defaultFetch): Promise<ItemFacts | null> {
  const [o, r] = repo.split('/');
  const res = await graphqlWith(token, fetchFn)<{ repository: { issueOrPullRequest: (RawItem & { __typename: string }) | null } | null }>(
    ITEM_QUERY, { o, r, n },
  );
  const item = res.data?.repository?.issueOrPullRequest;
  if (!item) return null;
  const ignore: Report = () => {};
  return item.__typename === 'PullRequest' ? prFacts(repo, item, ignore) : issueFacts(repo, item, ignore);
}
