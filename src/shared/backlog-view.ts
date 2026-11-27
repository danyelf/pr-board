// The backlog part of the board the page draws: a line per repo with its "Find some more" button, the proposal cards,
// and the cards of the issues picked up and waiting for a session. Worked out from the board's tables and what GitHub says.
import { PROPOSAL_CHOICES, WAITING, isAsked, isUnderWay, pickupReason, type Pickup, type Proposal, type RepoIssues, type ServiceLook } from './backlog.ts';
import type { Facts } from './facts.ts';
import { LABEL_IN_PROGRESS } from './names.ts';
import type { BoardView } from './view.ts';
import { itemKey, type WorkRecord } from './work.ts';

/** After this long without a look, the page says the Mac service seems to have stopped. */
export const LOOK_GOES_STALE_MS = 5 * 60 * 1000;

export interface BacklogLine {
  repo: string;
  /** The repo's name without its owner, as the line shows it. */
  name: string;
  /** Open issues with no record, not picked up and with nobody's in-progress label; null when GitHub couldn't be read. */
  open: number | null;
  /** True when the repo has more open issues than the board reads, so the count is a lower bound. */
  atLeast: boolean;
  /** What the line says instead of the button while a proposal is under way; null when the button is offered. */
  busy: string | null;
}

export interface ProposalQuestion {
  issue: number;
  title: string;
  url: string;
  reason: string;
  choices: string[];
  defaultChoice: string;
}

export interface ProposalCard {
  key: string;
  id: number;
  repo: string;
  title: string;
  tag: string;
  section: 'waiting' | 'onClaude';
  since: string;
  questions: ProposalQuestion[];
  /** True while the owner can send answers. */
  answerable: boolean;
  /** What went wrong, when it did. */
  failure: string | null;
  /** A proposal whose session never wrote a list can be tried again; any failed one can be dismissed. */
  canRetry: boolean;
  canDismiss: boolean;
  /** What the owner sent, once they have. */
  sent: { at: string; answers: Record<string, string>; note: string } | null;
}

export interface PickupCard {
  key: string;
  id: number;
  repo: string;
  issue: number;
  title: string;
  url: string;
  tag: string;
  section: 'waiting' | 'onClaude';
  since: string;
  /** Why the proposal suggested it, when it came from one. */
  reason: string | null;
  failure: string | null;
  canRetry: boolean;
  canDrop: boolean;
}

/** An issue the latest proposal for its repo said is waiting on other open work. */
export interface WaitingLine {
  key: string;
  repo: string;
  issue: number;
  title: string;
  url: string;
  /** What it waits for, in the proposal's words. */
  reason: string;
}

/** What the page reads: the board, and the backlog at its foot. */
export type BoardPage = BoardView & { backlog: BacklogView };

export interface BacklogView {
  /** The Mac service's sessions at its last look; null when it has never reported. */
  sessions: { running: number; max: number; at: string; stale: boolean } | null;
  repos: BacklogLine[];
  proposals: ProposalCard[];
  pickups: PickupCard[];
  waiting: WaitingLine[];
}

const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
/** A repo's name without its owner. */
const shortName = (repo: string) => repo.split('/')[1] ?? repo;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function proposalCard(p: Proposal): ProposalCard | null {
  // A proposal still being looked for shows on its repo's line, not as a card.
  if (p.doneAt !== null || (p.items === null && p.failedAt === null)) return null;
  const items = (p.items ?? []).filter(isAsked);
  const failed = p.failedAt !== null;
  const answered = p.answeredAt !== null;
  const tag = failed ? 'went wrong'
    : answered ? (p.noteStartedAt !== null ? 'Claude acting on your note' : 'carrying out your answers')
      : items.length === 0 ? 'nothing to pick up' : plural(items.length, 'question');
  return {
    key: `${p.repo} proposal ${p.id}`,
    id: p.id,
    repo: p.repo,
    title: `Next from the ${shortName(p.repo)} backlog`,
    tag,
    section: failed || !answered ? 'waiting' : 'onClaude',
    since: p.failedAt ?? p.answeredAt ?? p.writtenAt ?? p.askedAt,
    questions: items.map((i) => ({
      issue: i.issue, title: i.title, url: issueUrl(p.repo, i.issue), reason: i.reason, choices: [...PROPOSAL_CHOICES], defaultChoice: i.suggestion,
    })),
    answerable: !failed && !answered,
    failure: p.failure,
    canRetry: failed && p.writtenAt === null,
    canDismiss: failed,
    sent: answered ? { at: p.answeredAt!, answers: p.answers ?? {}, note: p.note ?? '' } : null,
  };
}

function pickupCard(u: Pickup, proposals: Proposal[], factsOf: (repo: string, n: number) => Facts | undefined): PickupCard | null {
  if (u.doneAt !== null || u.droppedAt !== null) return null;
  const f = factsOf(u.repo, u.issue);
  const failed = u.failedAt !== null;
  return {
    key: `${itemKey(u.repo, u.issue)} pick-up`,
    id: u.id,
    repo: u.repo,
    issue: u.issue,
    title: f?.title ?? itemKey(u.repo, u.issue),
    url: f?.url ?? issueUrl(u.repo, u.issue),
    tag: failed ? 'Claude gave up' : u.startedAt !== null ? 'starting on design' : 'Picked up, waiting for a free session',
    section: failed ? 'waiting' : 'onClaude',
    since: u.failedAt ?? u.startedAt ?? u.askedAt,
    reason: pickupReason(u, proposals),
    failure: u.failure,
    canRetry: failed,
    canDrop: failed || u.startedAt === null,
  };
}

export function buildBacklog(
  look: ServiceLook | null,
  proposals: Proposal[],
  pickups: Pickup[],
  records: WorkRecord[],
  issues: RepoIssues[],
  facts: Facts[],
  now: Date,
): BacklogView {
  const byKey = new Map(facts.map((f) => [itemKey(f.repo, f.number), f]));
  const factsOf = (repo: string, n: number) => byKey.get(itemKey(repo, n));
  /** Issues of a repo that already have open work on the board or a pick-up. */
  const takenIn = (repo: string) => new Set<number>([
    ...records.filter((r) => r.repo === repo && r.endedAt === null && r.issue !== null).map((r) => r.issue!),
    ...pickups.filter((u) => u.repo === repo && u.doneAt === null).map((u) => u.issue),
  ]);

  const repos: BacklogLine[] = (look?.repos ?? []).map((repo) => {
    const list = issues.find((i) => i.repo === repo);
    const taken = takenIn(repo);
    const under = proposals.find((p) => p.repo === repo && isUnderWay(p));
    const busy = !under ? null
      : under.startedAt === null ? 'waiting for a free session to look through the backlog…'
        : under.writtenAt === null ? 'looking through the backlog…'
          : under.answeredAt === null ? 'a proposal is waiting for you'
            : 'carrying out your answers…';
    return {
      repo,
      name: shortName(repo),
      open: list ? list.issues.filter((i) => !i.labels.includes(LABEL_IN_PROGRESS) && !taken.has(i.number)).length : null,
      atLeast: list ? !list.complete : false,
      busy,
    };
  });

  // Each repo's newest written proposal says which issues are waiting; one since closed, or now taken, is left out.
  const waiting: WaitingLine[] = [];
  for (const repo of new Set(proposals.map((p) => p.repo))) {
    const latest = proposals.filter((p) => p.repo === repo && p.writtenAt !== null).sort((a, b) => b.id - a.id)[0];
    const list = issues.find((i) => i.repo === repo);
    const taken = takenIn(repo);
    for (const i of latest?.items ?? []) {
      if (i.suggestion !== WAITING || taken.has(i.issue)) continue;
      if (list?.complete && !list.issues.some((x) => x.number === i.issue)) continue;
      waiting.push({ key: `${itemKey(repo, i.issue)} waiting`, repo, issue: i.issue, title: i.title, url: issueUrl(repo, i.issue), reason: i.reason });
    }
  }

  return {
    sessions: look ? { running: look.running, max: look.max, at: look.at, stale: now.getTime() - Date.parse(look.at) >= LOOK_GOES_STALE_MS } : null,
    repos,
    proposals: proposals.map(proposalCard).filter((c): c is ProposalCard => c !== null).sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.id - b.id),
    pickups: pickups.map((u) => pickupCard(u, proposals, factsOf)).filter((c): c is PickupCard => c !== null).sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.id - b.id),
    waiting,
  };
}
