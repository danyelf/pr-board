import { CLAIM_REACTION, answersCurrentStatus, isClaimReaction, isOwnerAnswer, parseAnswer } from '../shared/answer.ts';
import { DAY_MS, LABEL_IN_PROGRESS, LABEL_ON_OWNER, LABEL_PARKED, REPO_WINDOW_DAYS, WRITTEN_ELSEWHERE } from '../shared/names.ts';
import { descriptionEditedAt, parseStatus, pickStatusComment, statusWrittenAt } from '../shared/status.ts';
import { effectiveTurn } from '../shared/turn.ts';
import type { Facts } from '../shared/facts.ts';
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
interface GraphqlResponse<T> { data?: T | null; errors?: { message: string; type?: string; path?: (string | number)[] }[] }

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

const CLAIMS_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on IssueComment { id reactions(content: ${CLAIM_REACTION.toUpperCase()}, first: ${CLAIMS_PER_ANSWER}) { nodes { content createdAt user { login } } } } }
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

// Everything from here to the facts section below, except the shared helpers above, is removed with the old page.
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
    if (e instanceof GitHubRefused) return { items: [], errors: [e.message] };
    throw e;
  }
}

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

/**
 * The owner's answers to the current status, oldest first, and the owner's newest answer whether or
 * not it is one of them. Whether each current one was claimed is read afterwards.
 */
function readAnswers(comments: Comment[], writtenAt: string | null): Pick<ItemFacts, 'answers' | 'lastAnswer'> {
  const answers: AnswerSeen[] = [];
  let lastAnswer: AnswerSeen | null = null;
  for (const c of comments) {
    if (c.id === undefined || !fromOwner(c)) continue;
    // Already known to parse: fromOwner only passes answer comments.
    const answer = parseAnswer(c.body)!;
    lastAnswer = { id: c.id, url: c.url, at: c.createdAt, claimedAt: null, choices: answer.answers, note: answer.note };
    if (answersCurrentStatus({ login: c.author?.login, body: c.body, createdAt: c.createdAt }, writtenAt)) answers.push(lastAnswer);
  }
  return { answers, lastAnswer };
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
  const writtenAt = statusWrittenAt(body, descriptionEditedAt(pr));
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
    statusWrittenAt: writtenAt,
    ...readAnswers(comments, writtenAt),
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
  const writtenAt = statusComment ? statusWrittenAt(statusComment.body, statusComment.updatedAt) : null;
  return {
    ...baseFacts(repo, issue, 'issue', labels, events, comments, []),
    isDraft: false, merged: false, mergedAt: null, mergeState: null, behindBase: false,
    linkedIssue: null, stackedOn: null, stackedOnOpen: false,
    previewUrl: null, addedDocs: [], screenshots: screenshotsIn(issue.body ?? ''),
    reviewSha: null, reviewUrl: null, commitsSinceReview: null,
    prepDone: false, commitsSincePrep: null,
    statusCommentBody: statusComment?.body ?? null,
    statusWrittenAt: writtenAt,
    ...readAnswers(comments, writtenAt),
    lastChangeAt: latestOrNull(comments.filter((c) => c !== statusComment && !fromOwner(c)).map((c) => c.createdAt)),
  };
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

/** Posts a comment on a PR or issue, and says which account it went up under. Throws if GitHub refuses. */
export async function postComment(
  token: string, repo: string, n: number, body: string, fetchFn: typeof fetch = defaultFetch,
): Promise<{ login: string | null }> {
  const path = repo.split('/').map(encodeURIComponent).join('/');
  const res = await fetchFn(`https://api.github.com/repos/${path}/issues/${n}/comments`, {
    method: 'POST', headers: headersFor(token), body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new GitHubRefused(res.status, res.statusText, await refusalMessage(res));
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
 * an item just before acting on it. Whether its answers have been picked up is not read. Throws when
 * GitHub reports anything but "not found", such as a rate limit, so that isn't taken for a missing item.
 */
export async function fetchItem(token: string, repo: string, n: number, fetchFn: typeof fetch = defaultFetch): Promise<ItemFacts | null> {
  const [o, r] = repo.split('/');
  const res = await graphqlWith(token, fetchFn)<{ repository: { issueOrPullRequest: (RawItem & { __typename: string }) | null } | null }>(
    ITEM_QUERY, { o, r, n },
  );
  const item = res.data?.repository?.issueOrPullRequest;
  if (!item) {
    const other = res.errors?.find((e) => e.type !== 'NOT_FOUND');
    if (other) throw new Error(`GitHub said: ${other.message}`);
    return null;
  }
  const ignore: Report = () => {};
  return item.__typename === 'PullRequest' ? prFacts(repo, item, ignore) : issueFacts(repo, item, ignore);
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

const CHECK_STATES: readonly string[] = ['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED'];

/** One PR or issue as the board's facts. Throws if a list GitHub should have sent is missing. */
function factsFrom(repo: string, node: FactNode, isPr: boolean, report: Report): Facts {
  const where = `${repo}#${node.number}`;
  const labels = listOfItem(node.labels, 'labels', FACT_LABELS, where, 'a board label may be missing', report).map((l) => l.name);
  const body = node.body ?? '';
  const base = {
    repo, number: node.number, title: node.title, url: node.url, labels,
    createdAt: node.createdAt, closedAt: node.closedAt,
    lastActivityAt: latest([node.createdAt, node.updatedAt, ...(node.closedAt ? [node.closedAt] : [])]),
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
    checks: rollup !== null && CHECK_STATES.includes(rollup) ? (rollup as Facts['checks']) : null,
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
            const key = `${name}#${p.facts.number}`;
            if (!pending.has(key)) pending.set(key, p);
          }
          errors.push(...repoErrors);
        } catch (e) {
          errors.push(`Couldn't read ${name}: ${e instanceof Error ? e.message : String(e)}`);
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
