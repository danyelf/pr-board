// The board's database: each piece of work, the answers sent to it, and a log of every change.
// Every write is one `db.batch`, which D1 runs as a single transaction. Statements in a batch can't read each
// other's results from JavaScript, so a statement that must depend on an earlier one asks the database itself
// (a `WHERE EXISTS` over what the earlier statement wrote).
import { GAVE_UP_ASK, SERVICE_WORKING_ASK, WORKING_ASK } from '../shared/names.ts';
import { APPROVAL_CHOICES, Refused, applySet, checkAnswer, turnOf, type AnswerInput, type AnswerRow, type SetInput, type State, type WorkRecord } from '../shared/work.ts';

/** The part of D1Database the store uses. */
export interface Db {
  prepare(sql: string): Stmt;
  batch(stmts: Stmt[]): Promise<unknown[]>;
}
export interface Stmt {
  bind(...v: unknown[]): Stmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface ItemRef {
  repo: string;
  n: number;
}
export type Actor = 'status' | 'answer' | 'claim' | 'service' | 'switch-over';

interface WorkRow {
  id: number;
  repo: string;
  issue: number | null;
  pr: number | null;
  has_design: number;
  gate: WorkRecord['gate'];
  state: State;
  reached: WorkRecord['reached'];
  ask: string;
  questions: string;
  to_test: string | null;
  back_reason: string | null;
  approved: string;
  rounds: string;
  prep_sha: string | null;
  version: number;
  turn_since: string;
  written_at: string;
  confirmed_at: string | null;
  started_at: string;
  ended_at: string | null;
  ended_how: WorkRecord['endedHow'];
}

interface AnswerDbRow {
  id: number;
  work_id: number;
  version: number;
  at: string;
  choices: string;
  approval: string | null;
  note: string;
  claimed_at: string | null;
  claimed_by: AnswerRow['claimedBy'];
  claimed_at_version: number | null;
  state_before: State | null;
  ask_before: string | null;
  turn_since_before: string | null;
  gave_up_at: string | null;
  give_up_hint: string | null;
}

type Written = { results: { id: number }[] };
type RecordFields = Omit<WorkRecord, 'id' | 'repo' | 'issue' | 'pr' | 'endedAt' | 'endedHow' | 'confirmedAt' | 'startedAt'>;

function toRecord(r: WorkRow): WorkRecord {
  return {
    id: r.id, repo: r.repo, issue: r.issue, pr: r.pr, hasDesign: r.has_design === 1, gate: r.gate, state: r.state, reached: r.reached,
    ask: r.ask, questions: JSON.parse(r.questions), toTest: r.to_test, backReason: r.back_reason, approved: JSON.parse(r.approved),
    rounds: JSON.parse(r.rounds), prepSha: r.prep_sha, version: r.version, turnSince: r.turn_since, writtenAt: r.written_at,
    confirmedAt: r.confirmed_at, startedAt: r.started_at, endedAt: r.ended_at, endedHow: r.ended_how,
  };
}

function toAnswer(r: AnswerDbRow): AnswerRow {
  return {
    id: r.id, workId: r.work_id, version: r.version, at: r.at, choices: JSON.parse(r.choices), approval: r.approval, note: r.note,
    claimedAt: r.claimed_at, claimedBy: r.claimed_by, stateBefore: r.state_before, gaveUpAt: r.gave_up_at,
    giveUpHint: r.give_up_hint,
  };
}

async function recordById(db: Db, id: number): Promise<WorkRecord> {
  const row = await db.prepare('SELECT * FROM work WHERE id = ?').bind(id).first<WorkRow>();
  if (!row) throw new Refused('That work is not on the board');
  return toRecord(row);
}

async function answersByIds(db: Db, ids: number[]): Promise<AnswerRow[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT * FROM answer WHERE id IN (${marks}) ORDER BY id`).bind(...ids).all<AnswerDbRow>();
  return results.map(toAnswer);
}

/** Pairs each answer with its record, for the answers of open work only. */
async function withRecords(db: Db, answers: AnswerRow[]): Promise<{ record: WorkRecord; answers: AnswerRow[] }[]> {
  const out: { record: WorkRecord; answers: AnswerRow[] }[] = [];
  for (const workId of [...new Set(answers.map((a) => a.workId))]) {
    out.push({ record: await recordById(db, workId), answers: answers.filter((a) => a.workId === workId) });
  }
  return out;
}

function logStmt(db: Db, workId: number | 'last', at: string, actor: Actor, change: unknown, guardSql: string, guardParams: unknown[]): Stmt {
  const id = workId === 'last' ? 'last_insert_rowid()' : '?';
  const params = workId === 'last' ? [] : [workId];
  return db
    .prepare(`INSERT INTO log (work_id, at, actor, change) SELECT ${id}, ?, ?, ? WHERE ${guardSql}`)
    .bind(...params, at, actor, JSON.stringify(change), ...guardParams);
}

const STILL_OPEN_AT = 'EXISTS (SELECT 1 FROM work WHERE id = ? AND version = ? AND ended_at IS NULL)';

async function findOpen(db: Db, column: 'pr' | 'issue', repo: string, n: number, withoutPr = false): Promise<WorkRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM work WHERE repo = ? AND ${column} = ? AND ended_at IS NULL${withoutPr ? ' AND pr IS NULL' : ''}`)
    .bind(repo, n)
    .first<WorkRow>();
  return row ? toRecord(row) : null;
}

/** The open record for a PR or issue number. A PR and an issue never share a number, so one lookup serves both. */
export async function findWork(db: Db, ref: ItemRef): Promise<WorkRecord | null> {
  const row = await db
    .prepare('SELECT * FROM work WHERE repo = ? AND (pr = ? OR issue = ?) AND ended_at IS NULL')
    .bind(ref.repo, ref.n, ref.n)
    .first<WorkRow>();
  return row ? toRecord(row) : null;
}

function insertRecord(db: Db, repo: string, issue: number | null, pr: number | null, f: RecordFields, startedAt: string): Stmt {
  return db
    .prepare(
      `INSERT INTO work (repo, issue, pr, has_design, gate, state, reached, ask, questions, to_test, back_reason, approved, rounds,
        prep_sha, version, turn_since, written_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      repo, issue, pr, f.hasDesign ? 1 : 0, f.gate, f.state, f.reached, f.ask, JSON.stringify(f.questions), f.toTest, f.backReason,
      JSON.stringify(f.approved), JSON.stringify(f.rounds), f.prepSha, f.version, f.turnSince, f.writtenAt, startedAt,
    );
}

const summary = (r: Pick<WorkRecord, 'gate' | 'state' | 'version'>) => ({ gate: r.gate, state: r.state, version: r.version });

/**
 * Writes a new status. The record it belongs to is found by the item's own number; failing that, by the PR it
 * replaces; failing that, by the issue it names (which attaches a new PR to the issue's record).
 */
export async function setStatus(
  db: Db,
  ref: ItemRef,
  input: SetInput & { issue: number | null; replaces: number | null },
  now: string,
): Promise<{ record: WorkRecord; handedOver: boolean }> {
  const prev =
    (await findWork(db, ref)) ??
    (input.replaces !== null ? await findOpen(db, 'pr', ref.repo, input.replaces) : null) ??
    // An issue's record takes a PR only while it has none. Otherwise this PR (a split, say) gets a record of its own.
    (input.issue !== null ? await findOpen(db, 'issue', ref.repo, input.issue, true) : null);
  const f = applySet(prev, input, now);
  const handedOver = turnOf(f.state) === 'owner' && (prev === null || turnOf(prev.state) !== 'owner');
  // The issue can sit on one open record only; a PR that names an issue another record already holds goes without it.
  const issueFree =
    input.issue !== null && input.issue !== prev?.issue && (await findOpen(db, 'issue', ref.repo, input.issue)) === null ? input.issue : null;

  if (prev === null) {
    const issue = input.isPr ? issueFree : ref.n;
    const pr = input.isPr ? ref.n : null;
    const results = (await db.batch([
      insertRecord(db, ref.repo, issue, pr, f, now),
      logStmt(db, 'last', now, 'status', { from: null, to: summary(f), ask: f.ask, issue, pr }, '1', []),
    ])) as Written[];
    return { record: await recordById(db, results[0]!.results[0]!.id), handedOver };
  }

  const issue = input.isPr ? (issueFree ?? prev.issue) : ref.n;
  const pr = input.isPr ? ref.n : prev.pr;
  const results = (await db.batch([
    db
      .prepare(
        `UPDATE work SET issue = ?, pr = ?, has_design = ?, gate = ?, state = ?, reached = ?, ask = ?, questions = ?, to_test = ?,
          back_reason = ?, approved = ?, rounds = ?, prep_sha = ?, version = ?, turn_since = ?, written_at = ?
         WHERE id = ? AND version = ? AND ended_at IS NULL RETURNING id`,
      )
      .bind(
        issue, pr, f.hasDesign ? 1 : 0, f.gate, f.state, f.reached, f.ask, JSON.stringify(f.questions), f.toTest, f.backReason,
        JSON.stringify(f.approved), JSON.stringify(f.rounds), f.prepSha, f.version, f.turnSince, f.writtenAt, prev.id, prev.version,
      ),
    logStmt(db, prev.id, now, 'status', { from: summary(prev), to: summary(f), ask: f.ask, issue, pr, replaces: input.replaces }, STILL_OPEN_AT, [prev.id, f.version]),
  ])) as Written[];
  if (results[0]!.results.length === 0) throw new Refused('This work changed while the status was being written. Try again.');
  return { record: await recordById(db, prev.id), handedOver };
}

/** Records that Claude looked at the item and the status is still right. */
export async function confirm(db: Db, ref: ItemRef, now: string): Promise<WorkRecord> {
  const r = await findWork(db, ref);
  if (!r) throw new Refused(`${ref.repo}#${ref.n} has no status on the board. Run pr-status set first.`);
  await db.batch([
    db.prepare('UPDATE work SET confirmed_at = ? WHERE id = ? AND ended_at IS NULL').bind(now, r.id),
    logStmt(db, r.id, now, 'status', { confirmed: true, version: r.version }, STILL_OPEN_AT, [r.id, r.version]),
  ]);
  return recordById(db, r.id);
}

/**
 * Stores an answer from the owner. A version takes one answer with choices or an approval; notes alone are always kept.
 * An answer a session gave up on doesn't count, so the owner can answer again after a give-up.
 * The checks run inside the insert, so two sends at once can't both land.
 */
export async function addAnswer(db: Db, ref: ItemRef, a: AnswerInput, now: string): Promise<AnswerRow> {
  const r = await findWork(db, ref);
  if (!r) throw new Refused(`${ref.repo}#${ref.n} is not open on the board`);
  const refusal = checkAnswer(r, a);
  if (refusal) throw new Refused(refusal);

  const takesTheAnswer = Object.keys(a.choices).length > 0 || a.approval !== null;
  const noOtherAnswer = takesTheAnswer
    ? " AND NOT EXISTS (SELECT 1 FROM answer WHERE work_id = ? AND version = ? AND gave_up_at IS NULL AND (approval IS NOT NULL OR choices <> '{}'))"
    : '';
  const insert = db
    .prepare(
      `INSERT INTO answer (work_id, version, at, choices, approval, note)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${STILL_OPEN_AT}${noOtherAnswer} RETURNING id`,
    )
    .bind(r.id, a.version, now, JSON.stringify(a.choices), a.approval, a.note, r.id, a.version, ...(takesTheAnswer ? [r.id, a.version] : []));

  const stored = 'EXISTS (SELECT 1 FROM answer WHERE work_id = ? AND version = ? AND at = ? AND IFNULL(approval, \'\') = ? AND note = ?)';
  const storedParams = [r.id, a.version, now, a.approval ?? '', a.note];
  const stmts = [insert];
  const approves = r.gate !== 'prep' && a.approval !== null && a.approval === APPROVAL_CHOICES[r.gate][0];
  if (approves) {
    stmts.push(
      db
        .prepare(`UPDATE work SET approved = json_set(approved, '$.' || ?, ?) WHERE id = ? AND version = ? AND ${stored}`)
        .bind(r.gate, now, r.id, a.version, ...storedParams),
    );
  }
  stmts.push(logStmt(db, r.id, now, 'answer', { version: a.version, choices: a.choices, approval: a.approval, hasNote: a.note !== '' }, stored, storedParams));

  const results = (await db.batch(stmts)) as Written[];
  const id = results[0]!.results[0]?.id;
  if (id === undefined) {
    const now2 = await findWork(db, ref);
    throw new Refused(
      now2 && now2.version === a.version
        ? 'This already has an answer. Reload the card to see it.'
        : 'This changed since you opened it. Reload the card and answer again.',
    );
  }
  return (await answersByIds(db, [id]))[0]!;
}

/**
 * Answers nobody has claimed, to any version. A choice or approval can only be stored against the version it answers,
 * but a note can arrive late; an unclaimed answer to an older version is a note Claude hasn't seen.
 */
async function waiting(db: Db, r: WorkRecord): Promise<AnswerRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM answer WHERE work_id = ? AND claimed_at IS NULL ORDER BY id')
    .bind(r.id)
    .all<AnswerDbRow>();
  return results.map(toAnswer);
}

export async function unclaimedAnswers(db: Db, refs: ItemRef[]): Promise<{ record: WorkRecord; answers: AnswerRow[] }[]> {
  const out: { record: WorkRecord; answers: AnswerRow[] }[] = [];
  const seen = new Set<number>();
  for (const ref of refs) {
    const record = await findWork(db, ref);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    const answers = await waiting(db, record);
    if (answers.length > 0) out.push({ record, answers });
  }
  return out;
}

/**
 * For the Mac service. Records in the working state are left out, whether a claim set it or a session wrote it, so the
 * service never starts a second session beside one that is working. A note to such a record waits for that session's watcher.
 */
export async function unclaimedOlderThan(db: Db, before: string): Promise<{ record: WorkRecord; answers: AnswerRow[] }[]> {
  const { results } = await db
    .prepare(
      `SELECT a.* FROM answer a JOIN work w ON w.id = a.work_id
       WHERE w.ended_at IS NULL AND a.claimed_at IS NULL AND a.at < ? AND w.state <> 'working'
       ORDER BY a.id`,
    )
    .bind(before)
    .all<AnswerDbRow>();
  return withRecords(db, results.map(toAnswer));
}

/**
 * Claims every waiting answer of a record and sets the record to working, in one batch. The answers update
 * only takes answers nobody has claimed, and the record update only runs if this call's claim is there to find,
 * so a second claim changes nothing. The claim leaves the version alone. It takes the answers of every version.
 * A claim that lands on a record already working (a late note) marks the answers and leaves the record as it is;
 * its "before" values come from the record's live claim if there is one, since that claim saw the record first.
 */
export async function claim(db: Db, ref: ItemRef, by: 'session' | 'service', now: string): Promise<{ record: WorkRecord; answers: AnswerRow[] }> {
  const r = await findWork(db, ref);
  if (!r) throw new Refused(`${ref.repo}#${ref.n} is not open on the board`);
  const mine = 'EXISTS (SELECT 1 FROM answer WHERE work_id = ? AND claimed_at = ? AND claimed_by = ?)';
  const liveClaim = (column: string) =>
    `(SELECT l.${column} FROM answer l WHERE l.work_id = ? AND l.claimed_at_version = (SELECT version FROM work WHERE id = ?)
       AND l.claimed_at IS NOT NULL AND l.gave_up_at IS NULL AND l.state_before IS NOT NULL ORDER BY l.claimed_at, l.id LIMIT 1)`;
  const results = (await db.batch([
    db
      .prepare(
        `UPDATE answer SET claimed_at = ?, claimed_by = ?, claimed_at_version = (SELECT version FROM work WHERE id = ?),
           state_before = COALESCE(${liveClaim('state_before')}, (SELECT state FROM work WHERE id = ?)),
           ask_before = COALESCE(${liveClaim('ask_before')}, (SELECT ask FROM work WHERE id = ?)),
           turn_since_before = COALESCE(${liveClaim('turn_since_before')}, (SELECT turn_since FROM work WHERE id = ?))
         WHERE work_id = ? AND claimed_at IS NULL RETURNING id`,
      )
      .bind(now, by, ...Array<number>(11).fill(r.id)),
    db
      .prepare(`UPDATE work SET state = 'working', ask = ?, turn_since = ? WHERE id = ? AND state <> 'working' AND ${mine}`)
      .bind(by === 'service' ? SERVICE_WORKING_ASK : WORKING_ASK, now, r.id, r.id, now, by),
    logStmt(db, r.id, now, 'claim', { by, version: r.version }, mine, [r.id, now, by]),
  ])) as Written[];
  return { record: await recordById(db, r.id), answers: await answersByIds(db, results[0]!.results.map((x) => x.id)) };
}

/** What a set of claimed answers was claimed from. The earliest claim saw the record as it was before any claim. */
async function claimedFrom(db: Db, answerIds: number[]): Promise<AnswerDbRow | null> {
  if (answerIds.length === 0) return null;
  const marks = answerIds.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM answer WHERE id IN (${marks}) AND claimed_at IS NOT NULL AND gave_up_at IS NULL ORDER BY claimed_at, id LIMIT 1`)
    .bind(...answerIds)
    .first<AnswerDbRow>();
}

/** The session failed to start: the answers go back to waiting, and the record to what it was before the claim. */
export async function unclaim(db: Db, answerIds: number[]): Promise<void> {
  const first = await claimedFrom(db, answerIds);
  if (!first || first.state_before === null || first.ask_before === null) return;
  const marks = answerIds.map(() => '?').join(',');
  const claimedVersion = first.claimed_at_version ?? first.version;
  await db.batch([
    // The record goes back only when no other claim is still live; a late note's claim leaves the first claim's work alone.
    db
      .prepare(
        `UPDATE work SET state = ?, ask = ?, turn_since = ?
         WHERE id = ? AND version = ? AND state = 'working' AND ended_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM answer WHERE work_id = ? AND claimed_at_version = ? AND claimed_at IS NOT NULL AND gave_up_at IS NULL AND id NOT IN (${marks}))`,
      )
      .bind(first.state_before, first.ask_before, first.turn_since_before, first.work_id, claimedVersion, first.work_id, claimedVersion, ...answerIds),
    db
      .prepare(
        `UPDATE answer SET claimed_at = NULL, claimed_by = NULL, claimed_at_version = NULL, state_before = NULL, ask_before = NULL, turn_since_before = NULL
         WHERE id IN (${marks}) AND claimed_at IS NOT NULL AND gave_up_at IS NULL`,
      )
      .bind(...answerIds),
    // Putting answers back has no time of its own to pass in, so the log takes the database's clock.
    db
      .prepare("INSERT INTO log (work_id, at, actor, change) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'service', ?)")
      .bind(first.work_id, JSON.stringify({ unclaimed: answerIds })),
  ]);
}

/**
 * The session ended without writing a new status: the record goes back to the owner. The hint where to look is kept on
 * the answers, and the record's how-to-test is left as it was.
 */
export async function giveUp(db: Db, answerIds: number[], hint: string, now: string): Promise<void> {
  const first = await claimedFrom(db, answerIds);
  if (!first || first.state_before === null) return;
  const marks = answerIds.map(() => '?').join(',');
  const claimedVersion = first.claimed_at_version ?? first.version;
  const gaveUp = 'EXISTS (SELECT 1 FROM answer WHERE id = ? AND gave_up_at = ?)';
  // Giving up hands the item back to the owner, so it never writes "working" next to the gave-up ask.
  const handBackTo = first.state_before === 'paused' || first.state_before === 'complete' ? first.state_before : 'paused';
  await db.batch([
    db
      .prepare(
        `UPDATE work SET state = ?, ask = ?, turn_since = ?
         WHERE id = ? AND version = ? AND state = 'working' AND ended_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM answer WHERE work_id = ? AND claimed_at_version = ? AND claimed_at IS NOT NULL AND gave_up_at IS NULL AND id NOT IN (${marks}))`,
      )
      .bind(handBackTo, GAVE_UP_ASK, now, first.work_id, claimedVersion, first.work_id, claimedVersion, ...answerIds),
    db
      .prepare(`UPDATE answer SET gave_up_at = ?, give_up_hint = ? WHERE id IN (${marks}) AND claimed_at IS NOT NULL AND gave_up_at IS NULL`)
      .bind(now, hint, ...answerIds),
    logStmt(db, first.work_id, now, 'service', { gaveUp: answerIds, hint }, gaveUp, [first.id, now]),
  ]);
}

/** Answers claimed by the service that it hasn't given up on, while the record is still at the version it had when they were claimed. */
export async function serviceClaims(db: Db): Promise<{ record: WorkRecord; answers: AnswerRow[] }[]> {
  const { results } = await db
    .prepare(
      `SELECT a.* FROM answer a JOIN work w ON w.id = a.work_id
       WHERE w.ended_at IS NULL AND a.claimed_at_version = w.version AND a.claimed_by = 'service' AND a.gave_up_at IS NULL ORDER BY a.id`,
    )
    .all<AnswerDbRow>();
  return withRecords(db, results.map(toAnswer));
}

/** Every open record, every answer to its current version, and the newest answer a session gave up on. */
export async function openWork(db: Db): Promise<{ records: WorkRecord[]; answers: AnswerRow[] }> {
  const records = (await db.prepare('SELECT * FROM work WHERE ended_at IS NULL ORDER BY id').all<WorkRow>()).results.map(toRecord);
  const { results } = await db
    .prepare(
      `SELECT a.* FROM answer a JOIN work w ON w.id = a.work_id
       WHERE w.ended_at IS NULL AND (a.version = w.version OR a.id = (
         SELECT g.id FROM answer g WHERE g.work_id = a.work_id AND g.gave_up_at IS NOT NULL ORDER BY g.gave_up_at DESC, g.id DESC LIMIT 1))
       ORDER BY a.id`,
    )
    .all<AnswerDbRow>();
  return { records, answers: results.map(toAnswer) };
}

/** Closes a record. The log says which gate it was in. */
export async function endWork(db: Db, workId: number, how: 'merged' | 'closed', now: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE work SET ended_at = ?, ended_how = ? WHERE id = ? AND ended_at IS NULL').bind(now, how, workId),
    db
      .prepare(
        `INSERT INTO log (work_id, at, actor, change)
         SELECT id, ?, 'service', json_object('ended', ?, 'gate', gate, 'state', state) FROM work WHERE id = ? AND ended_at = ?`,
      )
      .bind(now, how, workId, now),
  ]);
}

/** Brings in a piece of work that already exists outside the board. It refuses when the board already has it. */
export async function importWork(
  db: Db,
  ref: ItemRef,
  r: Omit<WorkRecord, 'id' | 'repo' | 'version' | 'endedAt' | 'endedHow' | 'confirmedAt'>,
  now: string,
): Promise<WorkRecord> {
  if (await findWork(db, ref)) throw new Refused(`${ref.repo}#${ref.n} already has a record on the board`);
  const results = (await db.batch([
    insertRecord(db, ref.repo, r.issue, r.pr, { ...r, version: 1 }, r.startedAt),
    logStmt(db, 'last', now, 'switch-over', { imported: summary({ ...r, version: 1 }), ask: r.ask }, '1', []),
  ])) as Written[];
  return recordById(db, results[0]!.results[0]!.id);
}
