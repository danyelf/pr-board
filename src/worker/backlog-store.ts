// The board's database for the backlog: proposals, picked-up issues, and the Mac service's last look.
// Each step that must happen once (a claim, an answer) is one UPDATE whose WHERE says the step hasn't happened yet,
// so two at once can't both land.
import {
  LATER, LATER_MS, PROPOSAL_CHOICES, isUnderWay, type ItemInput, type Pickup, type Proposal, type ProposalChoice, type ProposalItem,
  type ServiceLook, type Skip,
} from '../shared/backlog.ts';
import { OWNER_NAME } from '../shared/config.ts';
import { NOTE_MAX } from '../shared/names.ts';
import { Refused, itemKey } from '../shared/work.ts';
import type { Db } from './store.ts';

interface ProposalRow {
  id: number;
  repo: string;
  asked_at: string;
  started_at: string | null;
  written_at: string | null;
  items: string | null;
  answered_at: string | null;
  answers: string | null;
  note: string | null;
  carried_at: string | null;
  carry_done_at: string | null;
  note_started_at: string | null;
  done_at: string | null;
  failed_at: string | null;
  failure: string | null;
}

interface PickupRow {
  id: number;
  repo: string;
  issue: number;
  proposal_id: number | null;
  asked_at: string;
  started_at: string | null;
  done_at: string | null;
  failed_at: string | null;
  failure: string | null;
  dropped_at: string | null;
}

type Changed = { results: { id: number }[] };

function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id, repo: r.repo, askedAt: r.asked_at, startedAt: r.started_at, writtenAt: r.written_at,
    items: r.items === null ? null : (JSON.parse(r.items) as ProposalItem[]), answeredAt: r.answered_at,
    answers: r.answers === null ? null : (JSON.parse(r.answers) as Record<string, ProposalChoice>), note: r.note,
    carriedAt: r.carried_at, carryDoneAt: r.carry_done_at, noteStartedAt: r.note_started_at, doneAt: r.done_at, failedAt: r.failed_at, failure: r.failure,
  };
}

function toPickup(r: PickupRow): Pickup {
  return {
    id: r.id, repo: r.repo, issue: r.issue, proposalId: r.proposal_id, askedAt: r.asked_at, startedAt: r.started_at,
    doneAt: r.done_at, failedAt: r.failed_at, failure: r.failure, droppedAt: r.dropped_at,
  };
}

export async function proposalById(db: Db, id: number): Promise<Proposal> {
  const row = await db.prepare('SELECT * FROM proposal WHERE id = ?').bind(id).first<ProposalRow>();
  if (!row) throw new Refused(`There is no proposal ${id} on the board`);
  return toProposal(row);
}

async function pickupById(db: Db, id: number): Promise<Pickup> {
  const row = await db.prepare('SELECT * FROM pickup WHERE id = ?').bind(id).first<PickupRow>();
  if (!row) throw new Refused(`There is no pick-up ${id} on the board`);
  return toPickup(row);
}

/** Runs one guarded UPDATE … RETURNING id; refuses with `why` when its guard let nothing through. */
async function step(db: Db, sql: string, params: unknown[], why: string): Promise<void> {
  const res = (await db.prepare(`${sql} RETURNING id`).bind(...params).all<{ id: number }>()) as Changed;
  if (res.results.length === 0) throw new Refused(why);
}

const UNDER_WAY = 'done_at IS NULL AND failed_at IS NULL';

/** The proposal a repo has under way, if any. */
export async function proposalUnderWay(db: Db, repo: string): Promise<Proposal | null> {
  const row = await db.prepare(`SELECT * FROM proposal WHERE repo = ? AND ${UNDER_WAY}`).bind(repo).first<ProposalRow>();
  return row ? toProposal(row) : null;
}

/** "Find some more": a new proposal for the repo. A repo has one under way at a time. */
export async function askProposal(db: Db, repo: string, now: string): Promise<Proposal> {
  if (await proposalUnderWay(db, repo)) throw new Refused(`${repo} already has a proposal under way`);
  const res = await db
    .prepare(`INSERT INTO proposal (repo, asked_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM proposal WHERE repo = ? AND ${UNDER_WAY}) RETURNING id`)
    .bind(repo, now, repo)
    .all<{ id: number }>();
  const id = res.results[0]?.id;
  if (id === undefined) throw new Refused(`${repo} already has a proposal under way`);
  return proposalById(db, id);
}

/**
 * Every proposal that isn't done, including failed ones, which wait for the owner. Also the done ones an open
 * pick-up came from, which hold the reason it was picked.
 */
export async function openProposals(db: Db): Promise<Proposal[]> {
  const { results } = await db
    .prepare('SELECT * FROM proposal WHERE done_at IS NULL OR id IN (SELECT proposal_id FROM pickup WHERE done_at IS NULL) ORDER BY id')
    .all<ProposalRow>();
  return results.map(toProposal);
}

/** The service takes a proposal to start its session. */
export async function claimProposal(db: Db, id: number, now: string): Promise<Proposal> {
  await step(db, `UPDATE proposal SET started_at = ? WHERE id = ? AND started_at IS NULL AND ${UNDER_WAY}`, [now, id], 'That proposal has already been taken');
  return proposalById(db, id);
}

/** The session couldn't start: the proposal waits for the next look. */
export async function unclaimProposal(db: Db, id: number): Promise<void> {
  await db.prepare(`UPDATE proposal SET started_at = NULL WHERE id = ? AND written_at IS NULL AND ${UNDER_WAY}`).bind(id).run();
}

/**
 * What the proposal session is told to leave out: issues the owner said "later" to recently, issues already picked up,
 * and issues that already have a record.
 */
export async function skipsFor(db: Db, repo: string, now: string): Promise<Skip[]> {
  const skips = new Map<number, string>();
  const since = new Date(Date.parse(now) - LATER_MS).toISOString();
  const { results: answered } = await db
    .prepare('SELECT * FROM proposal WHERE repo = ? AND answered_at IS NOT NULL AND answered_at >= ? ORDER BY id')
    .bind(repo, since)
    .all<ProposalRow>();
  for (const p of answered.map(toProposal)) {
    for (const [issue, choice] of Object.entries(p.answers ?? {})) {
      if (choice === LATER) skips.set(Number(issue), `${OWNER_NAME} said "later" to it on ${p.answeredAt!.slice(0, 10)}`);
    }
  }
  const { results: picked } = await db.prepare('SELECT issue FROM pickup WHERE repo = ? AND done_at IS NULL').bind(repo).all<{ issue: number }>();
  for (const p of picked) skips.set(p.issue, 'it is already picked up and waiting for a session');
  const { results: records } = await db
    .prepare('SELECT issue FROM work WHERE repo = ? AND ended_at IS NULL AND issue IS NOT NULL')
    .bind(repo)
    .all<{ issue: number }>();
  for (const r of records) skips.set(r.issue, 'it already has a record on the board');
  return [...skips].map(([issue, why]) => ({ issue, why })).sort((a, b) => a.issue - b.issue);
}

/** The session's list, with each issue's title as GitHub gives it. Goes to the repo's proposal whose session is running. */
export async function writeProposal(db: Db, repo: string, items: (ItemInput & { title: string })[], now: string): Promise<Proposal> {
  const p = await proposalUnderWay(db, repo);
  if (!p || p.startedAt === null || p.writtenAt !== null) throw new Refused(`${repo} has no proposal waiting for its list`);
  const list: ProposalItem[] = items.map((i) => ({ issue: i.issue, title: i.title, suggestion: i.suggestion, reason: i.reason }));
  await step(
    db,
    `UPDATE proposal SET items = ?, written_at = ? WHERE id = ? AND started_at IS NOT NULL AND written_at IS NULL AND ${UNDER_WAY}`,
    [JSON.stringify(list), now, p.id],
    `${repo} has no proposal waiting for its list`,
  );
  return proposalById(db, p.id);
}

/** The owner's answers: a choice for every issue on the list, and a note. */
export async function answerProposal(db: Db, id: number, answers: Record<string, string>, note: string, now: string): Promise<Proposal> {
  const p = await proposalById(db, id);
  if (p.items === null || p.answeredAt !== null || !isUnderWay(p)) throw new Refused('This proposal has already been answered, or is no longer open. Reload the page.');
  if (note.length > NOTE_MAX) throw new Refused(`The note is longer than ${NOTE_MAX} characters`);
  const listed = new Set(p.items.map((i) => String(i.issue)));
  for (const [issue, choice] of Object.entries(answers)) {
    if (!listed.has(issue)) throw new Refused(`#${issue} isn't on this proposal`);
    if (!(PROPOSAL_CHOICES as readonly string[]).includes(choice)) throw new Refused(`"${choice}" isn't one of the choices for #${issue}`);
  }
  for (const issue of listed) if (answers[issue] === undefined) throw new Refused(`#${issue} has no answer`);
  await step(
    db,
    `UPDATE proposal SET answers = ?, note = ?, answered_at = ? WHERE id = ? AND written_at IS NOT NULL AND answered_at IS NULL AND ${UNDER_WAY}`,
    [JSON.stringify(answers), note, now, id],
    'This proposal has already been answered. Reload the page.',
  );
  return proposalById(db, id);
}

/** The service takes the answers to carry them out. */
export async function carryProposal(db: Db, id: number, now: string): Promise<Proposal> {
  await step(db, `UPDATE proposal SET carried_at = ? WHERE id = ? AND answered_at IS NOT NULL AND carried_at IS NULL AND ${UNDER_WAY}`, [now, id], 'Those answers have already been taken');
  return proposalById(db, id);
}

/** Every choice is carried out; a proposal with a note now waits for the note's session. */
export async function carryDone(db: Db, id: number, now: string): Promise<void> {
  await step(db, `UPDATE proposal SET carry_done_at = ? WHERE id = ? AND carried_at IS NOT NULL AND carry_done_at IS NULL AND ${UNDER_WAY}`, [now, id], 'Those answers are not being carried out');
}

/** The service started a session for the note. */
export async function noteStarted(db: Db, id: number, now: string): Promise<Proposal> {
  await step(
    db,
    `UPDATE proposal SET note_started_at = ? WHERE id = ? AND carry_done_at IS NOT NULL AND note <> '' AND note_started_at IS NULL AND ${UNDER_WAY}`,
    [now, id],
    'That note already has a session',
  );
  return proposalById(db, id);
}

/** The note's session couldn't start: the note waits for the next look. */
export async function noteUnstarted(db: Db, id: number): Promise<void> {
  await db.prepare(`UPDATE proposal SET note_started_at = NULL WHERE id = ? AND ${UNDER_WAY}`).bind(id).run();
}

/** The answers are carried out (and the note acted on, if there was one): the card leaves the page. */
export async function finishProposal(db: Db, id: number, now: string): Promise<void> {
  await step(db, `UPDATE proposal SET done_at = ? WHERE id = ? AND answered_at IS NOT NULL AND ${UNDER_WAY}`, [now, id], 'That proposal is not waiting to be finished');
}

/** The repo's answered proposal, for the note's session, which knows the repo but not the proposal's number. */
export async function answeredProposal(db: Db, repo: string): Promise<Proposal> {
  const p = await proposalUnderWay(db, repo);
  if (!p || p.answeredAt === null) throw new Refused(`${repo} has no answered proposal under way`);
  return p;
}

/** Something went wrong: the proposal goes back to the owner with what it was. */
export async function failProposal(db: Db, id: number, failure: string, now: string): Promise<void> {
  await step(db, `UPDATE proposal SET failed_at = ?, failure = ? WHERE id = ? AND ${UNDER_WAY}`, [now, failure, id], 'That proposal is no longer under way');
}

/** Tries a failed proposal again. Only one that failed before its list was written can: nothing has been done for it yet. */
export async function retryProposal(db: Db, id: number): Promise<void> {
  const p = await proposalById(db, id);
  if (p.failedAt === null || p.doneAt !== null || p.writtenAt !== null) throw new Refused('Only a proposal whose session never wrote its list can be tried again');
  if (await proposalUnderWay(db, p.repo)) throw new Refused(`${p.repo} already has another proposal under way`);
  await step(
    db,
    `UPDATE proposal SET started_at = NULL, failed_at = NULL, failure = NULL WHERE id = ? AND failed_at IS NOT NULL AND done_at IS NULL AND written_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM proposal o WHERE o.repo = proposal.repo AND ${UNDER_WAY})`,
    [id],
    `${p.repo} already has another proposal under way`,
  );
}

/** The owner has read what went wrong: the failed card leaves the page. */
export async function dismissProposal(db: Db, id: number, now: string): Promise<void> {
  await step(db, 'UPDATE proposal SET done_at = ? WHERE id = ? AND failed_at IS NOT NULL AND done_at IS NULL', [now, id], 'That proposal is not waiting to be dismissed');
}

// ---------------------------------------------------------------------------
// Picked-up issues.
// ---------------------------------------------------------------------------

/** Picks up an issue: it waits for a free session. Refused when it is already picked up or already has a record. */
export async function addPickup(db: Db, repo: string, issue: number, proposalId: number | null, now: string): Promise<Pickup> {
  const key = itemKey(repo, issue);
  const res = await db
    .prepare(
      `INSERT INTO pickup (repo, issue, proposal_id, asked_at) SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM pickup WHERE repo = ? AND issue = ? AND done_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM work WHERE repo = ? AND (issue = ? OR pr = ?) AND ended_at IS NULL) RETURNING id`,
    )
    .bind(repo, issue, proposalId, now, repo, issue, repo, issue, issue)
    .all<{ id: number }>();
  const id = res.results[0]?.id;
  if (id === undefined) throw new Refused(`${key} is already picked up, or already has a record on the board`);
  return pickupById(db, id);
}

export async function openPickups(db: Db): Promise<Pickup[]> {
  const { results } = await db.prepare('SELECT * FROM pickup WHERE done_at IS NULL ORDER BY id').all<PickupRow>();
  return results.map(toPickup);
}

export async function claimPickup(db: Db, id: number, now: string): Promise<Pickup> {
  await step(db, 'UPDATE pickup SET started_at = ? WHERE id = ? AND started_at IS NULL AND done_at IS NULL AND failed_at IS NULL AND dropped_at IS NULL', [now, id], 'That pick-up has already been taken');
  return pickupById(db, id);
}

export async function unclaimPickup(db: Db, id: number): Promise<void> {
  await db.prepare('UPDATE pickup SET started_at = NULL WHERE id = ? AND done_at IS NULL AND failed_at IS NULL').bind(id).run();
}

/** The session ended without writing the issue's first status: it goes back to the owner. */
export async function failPickup(db: Db, id: number, failure: string, now: string): Promise<void> {
  await step(db, 'UPDATE pickup SET failed_at = ?, failure = ? WHERE id = ? AND done_at IS NULL AND failed_at IS NULL', [now, failure, id], 'That pick-up is no longer waiting');
}

export async function retryPickup(db: Db, id: number): Promise<void> {
  await step(db, 'UPDATE pickup SET started_at = NULL, failed_at = NULL, failure = NULL WHERE id = ? AND failed_at IS NOT NULL AND done_at IS NULL AND dropped_at IS NULL', [id], 'Only a pick-up whose session gave up can be tried again');
}

/** The owner drops a pick-up that hasn't started; the service then takes the label off and marks it done. */
export async function dropPickup(db: Db, id: number, now: string): Promise<void> {
  await step(
    db,
    'UPDATE pickup SET dropped_at = ? WHERE id = ? AND done_at IS NULL AND dropped_at IS NULL AND (started_at IS NULL OR failed_at IS NOT NULL)',
    [now, id],
    'That pick-up has a session working on it, or is already dropped',
  );
}

/** A picked-up issue that closed on GitHub: nothing is left to start. */
export async function endPickup(db: Db, id: number, now: string): Promise<void> {
  await db.prepare('UPDATE pickup SET done_at = ? WHERE id = ? AND done_at IS NULL').bind(now, id).run();
}

/** A dropped pick-up whose label is off. */
export async function finishPickup(db: Db, id: number, now: string): Promise<void> {
  await step(db, 'UPDATE pickup SET done_at = ? WHERE id = ? AND dropped_at IS NOT NULL AND done_at IS NULL', [now, id], 'That pick-up is not waiting to be finished');
}

// ---------------------------------------------------------------------------
// The Mac service's last look.
// ---------------------------------------------------------------------------

export async function recordLook(db: Db, look: ServiceLook): Promise<void> {
  await db
    .prepare(
      `INSERT INTO service_look (id, at, running, max_sessions, repos) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET at = excluded.at, running = excluded.running, max_sessions = excluded.max_sessions, repos = excluded.repos`,
    )
    .bind(look.at, look.running, look.max, JSON.stringify(look.repos))
    .run();
}

export async function lastLook(db: Db): Promise<ServiceLook | null> {
  const row = await db.prepare('SELECT * FROM service_look WHERE id = 1').first<{ at: string; running: number; max_sessions: number; repos: string }>();
  return row ? { at: row.at, running: row.running, max: row.max_sessions, repos: JSON.parse(row.repos) as string[] } : null;
}
