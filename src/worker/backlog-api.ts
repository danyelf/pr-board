// The board's routes for the backlog. The owner asks for a proposal, answers it, and tries again or drops what went wrong;
// the Mac service and its sessions (the service token) take the work, write the lists and say how it went.
import { PROPOSAL_CHOICES, itemsProblem, type ItemInput, type ProposalChoice } from '../shared/backlog.ts';
import { Refused, itemKey } from '../shared/work.ts';
import type { Env } from './access.ts';
import type { ApiDeps } from './api.ts';
import { BadRequest } from './bad-request.ts';
import {
  addPickup, answerProposal, answeredProposal, askProposal, carryDone, carryProposal, claimPickup, claimProposal, dismissProposal, dropPickup,
  failPickup, failProposal, finishPickup, finishProposal, lastLook, noteStarted, noteUnstarted, openPickups, openProposals,
  proposalById, recordLook, retryPickup, retryProposal, skipsFor, unclaimPickup, unclaimProposal, writeProposal,
} from './backlog-store.ts';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function positiveInt(b: Record<string, unknown>, key: string): number {
  const v = b[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new BadRequest(`"${key}" must be a positive whole number`);
  return v;
}
const id = (b: Record<string, unknown>) => positiveInt(b, 'id');
function repoOf(b: Record<string, unknown>): string {
  const v = b.repo;
  if (typeof v !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(v)) throw new BadRequest('"repo" must look like owner/name');
  return v;
}
function text(b: Record<string, unknown>, key: string): string {
  const v = b[key] ?? '';
  if (typeof v !== 'string') throw new BadRequest(`"${key}" must be text`);
  return v;
}

export const BACKLOG_OWNER_POST = ['/api/find-more', '/api/proposal-answer', '/api/proposal-retry', '/api/proposal-dismiss', '/api/pickup-retry', '/api/pickup-drop'];
export const BACKLOG_CLAUDE_GET = ['/api/backlog-work'];
export const BACKLOG_CLAUDE_POST = [
  '/api/service-look', '/api/proposal-claim', '/api/proposal-unclaim', '/api/proposal-write', '/api/proposal-carry', '/api/proposal-carry-done', '/api/proposal-note-started',
  '/api/proposal-note-unstarted', '/api/proposal-done', '/api/proposal-failed', '/api/pickup-add', '/api/pickup-claim', '/api/pickup-unclaim',
  '/api/pickup-failed', '/api/pickup-done',
];

/** Reads the items a session wrote, checks each is an open issue of the repo, and adds its title from GitHub. */
async function itemsWithTitles(env: Env, deps: ApiDeps, repo: string, raw: unknown): Promise<(ItemInput & { title: string })[]> {
  if (!Array.isArray(raw)) throw new BadRequest('"items" must be a list');
  const items: ItemInput[] = raw.map((v) => {
    const ok = isObject(v) && typeof v.issue === 'number' && Number.isInteger(v.issue) && v.issue > 0
      && (PROPOSAL_CHOICES as readonly string[]).includes(v.suggestion as string) && typeof v.reason === 'string' && v.reason.trim() !== '';
    if (!ok) throw new BadRequest('Each item needs an "issue" number, a "suggestion" (pick up, later or close) and a "reason"');
    return { issue: v.issue as number, suggestion: v.suggestion as ProposalChoice, reason: (v.reason as string).trim() };
  });
  const problem = itemsProblem(items);
  if (problem) throw new Refused(problem);
  if (items.length === 0) return [];
  const got = await deps.facts(env, [], true, items.map((i) => ({ repo, n: i.issue })));
  return items.map((i) => {
    const f = got.facts.find((x) => x.repo === repo && x.number === i.issue);
    if (!f) throw new Refused(`Couldn't read ${itemKey(repo, i.issue)} from GitHub${got.errors.length > 0 ? `: ${got.errors.join('; ')}` : ''}`);
    if (f.kind !== 'issue') throw new Refused(`${itemKey(repo, i.issue)} is a pull request, not an issue`);
    if (f.closedAt !== null) throw new Refused(`${itemKey(repo, i.issue)} is already closed`);
    return { ...i, title: f.title };
  });
}

/** Handles a backlog route; the caller has already checked who may call it and read the body. */
export async function handleBacklog(path: string, env: Env, deps: ApiDeps, b: Record<string, unknown>, now: string): Promise<unknown> {
  const db = env.DB;
  switch (path) {
    case '/api/backlog-work':
      return { proposals: await openProposals(db), pickups: await openPickups(db) };

    case '/api/find-more': {
      const repo = repoOf(b);
      const look = await lastLook(db);
      // Only the Mac service starts the session, so a repo it doesn't serve would wait for ever.
      if (!look?.repos.includes(repo)) throw new Refused(`The Mac service doesn't serve ${repo}, so nobody would look through its backlog`);
      return { proposal: await askProposal(db, repo, now) };
    }
    case '/api/proposal-answer': {
      const answers = b.answers ?? {};
      if (!isObject(answers) || Object.values(answers).some((c) => typeof c !== 'string')) throw new BadRequest('"answers" must map issue numbers to choices');
      return { proposal: await answerProposal(db, id(b), answers as Record<string, string>, text(b, 'note').trim(), now) };
    }
    case '/api/proposal-retry': await retryProposal(db, id(b)); return {};
    case '/api/proposal-dismiss': await dismissProposal(db, id(b), now); return {};
    case '/api/pickup-retry': await retryPickup(db, id(b)); return {};
    case '/api/pickup-drop': await dropPickup(db, id(b), now); return {};

    case '/api/service-look': {
      const running = b.running;
      const repos = b.repos;
      if (typeof running !== 'number' || !Number.isInteger(running) || running < 0) throw new BadRequest('"running" must be a whole number');
      const max = positiveInt(b, 'max');
      if (!Array.isArray(repos) || repos.some((r) => typeof r !== 'string')) throw new BadRequest('"repos" must be a list of repo names');
      await recordLook(db, { at: now, running, max, repos: repos as string[] });
      return {};
    }
    case '/api/proposal-claim': {
      const proposal = await claimProposal(db, id(b), now);
      return { proposal, skip: await skipsFor(db, proposal.repo, now) };
    }
    case '/api/proposal-unclaim': await unclaimProposal(db, id(b)); return {};
    case '/api/proposal-write': {
      const repo = repoOf(b);
      return { proposal: await writeProposal(db, repo, await itemsWithTitles(env, deps, repo, b.items), now) };
    }
    case '/api/proposal-carry': return { proposal: await carryProposal(db, id(b), now) };
    case '/api/proposal-carry-done': await carryDone(db, id(b), now); return {};
    case '/api/proposal-note-started': return { proposal: await noteStarted(db, id(b), now) };
    case '/api/proposal-note-unstarted': await noteUnstarted(db, id(b)); return {};
    case '/api/proposal-done': {
      // The note's session knows only the repo; the service knows the proposal.
      const pid = b.id !== undefined ? id(b) : (await answeredProposal(db, repoOf(b))).id;
      const problem = text(b, 'problem').trim();
      if (problem !== '') await failProposal(db, pid, problem, now);
      else await finishProposal(db, pid, now);
      return { proposal: await proposalById(db, pid) };
    }
    case '/api/proposal-failed':
    case '/api/pickup-failed': {
      const failure = text(b, 'failure').trim();
      if (failure === '') throw new BadRequest('"failure" must say what went wrong');
      await (path === '/api/proposal-failed' ? failProposal : failPickup)(db, id(b), failure, now);
      return {};
    }
    case '/api/pickup-add': {
      const proposalId = b.proposalId === undefined || b.proposalId === null ? null : positiveInt(b, 'proposalId');
      return { pickup: await addPickup(db, repoOf(b), positiveInt(b, 'number'), proposalId, now) };
    }
    case '/api/pickup-claim': return { pickup: await claimPickup(db, id(b), now) };
    case '/api/pickup-unclaim': await unclaimPickup(db, id(b)); return {};
    case '/api/pickup-done': await finishPickup(db, id(b), now); return {};
  }
  throw new BadRequest(`Unknown backlog route ${path}`);
}
