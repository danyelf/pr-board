# Three gates, with the board holding the workflow: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the six-box strip and the GitHub-as-message-queue design with three gates whose state lives in the board's own D1 database, a live page, and a status command, watcher, hook and Mac service that talk to the board instead of GitHub.

**Architecture:**
- **The Worker owns the workflow.** It stores records, answers and a log in D1. It reads GitHub only for what GitHub owns (PRs, checks, whether a PR can merge), and copies a few labels back to GitHub.
- **One view model, drawn in the browser.** The Worker builds the board from the records plus the GitHub facts and returns it as JSON. A small browser script, served as a static file, draws that JSON and keeps it current.
- **Everything on the Mac talks to one interface.** The status command, the watcher, the end-of-turn hook and the Mac service call the Worker's `/api/…` routes, signed in with a Cloudflare Access service token.

**Tech Stack:**
- TypeScript on Node 24 (run directly), with pnpm.
- Cloudflare Workers, D1, static assets, and Access.
- `jose` for checking Access tokens.
- esbuild for the page script.
- vitest for tests, with `node:sqlite` standing in for D1 in them.

**Spec:** `docs/superpowers/specs/2026-11-20-gates-and-board-state-design.md` (read it first; this plan argues from it).

## Global Constraints

- No ticket or stage references in code comments. Plain English in all text a person reads.
- The code never names a person: owner name and login come from `pr-board.config.json` (`OWNER_NAME`, `OWNER_LOGIN`); tests use `test/fixtures/pr-board.config.json`.
- Commands: `pnpm test`, `pnpm typecheck`, `pnpm build:page`. Never `cd … &&`; use `pnpm -C <worktree>` and `git -C <worktree>`.
- Commit with plain `git -C <worktree> commit -m "…" --trailer "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" --trailer "Claude-Session: https://claude.ai/code/session_01SVi92UYnNPG5UgwRmqiZH2"`. Never `--author` or `-c user.*`.
- Gates, in order: `design`, `implementation`, `prep`. States: `working`, `paused`, `complete`, `parked`.
- Danyel's choices, exactly: Design complete `approve, build it` · `needs changes`; Implementation complete `looks good, prep for merge` · `needs changes`; Prep complete: a note only, offered as "needs changes". Claude's questions keep `file an issue` (`FILE_AN_ISSUE`); approval questions don't offer it.
- Labels the board writes: `gate: design`, `gate: implementation`, `gate: prep`, `on <owner>` (`LABEL_ON_OWNER`), `ready to merge`, `parked`. It never touches `in-progress`.
- Asks written by code: `Working on your answers`, `A Mac session is working on your answers`, `A Mac session gave up on your answers` (keep the constants `WORKING_ASK`, `SERVICE_WORKING_ASK`, `GAVE_UP_ASK`).
- Timings: an answer goes back to Danyel after `PICKUP_GRACE_MS` (10 min); the Mac service waits `SERVICE_GRACE_MS` (5 min); a claimed answer stalls after `WORKING_STALLS_MS` (60 min). The GitHub cache lasts 60 s and the page refreshes every 30 s. Repos count if pushed in the last 60 days (`REPO_WINDOW_DAYS`). A card goes quiet after 3 days with no activity.
- A record's `version` goes up on `pr-status set` and on nothing else.
- Every failure to reach or be accepted by the board, on the Mac side, prints a line starting `⚠️` and exits non-zero. Nothing ever falls back to GitHub.
- The page script never puts outside text into HTML: no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` anywhere under `src/page/`.
- The Worker's policy header: `default-src 'none'; script-src 'self'; connect-src 'self'; img-src https:; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.

## Review Focus

1. **Two sends for the same version** (a double click, or two tabs). One is stored; the other gets a refusal with the fresh card. Exception: two note-only answers are both stored, since a note can't land on the wrong questions. This is the builder's reading of "a version takes one answer". (Task 2 test `refuses a second answer with choices to one version`.)
2. **Access answers with its login page instead of JSON**, because the service token expired or is missing. The Mac side must say ⚠️ and name the token file, not report a JSON parse error. (Task 9 test `says the service token was refused when Access answers with HTML`.)
3. **A refresh arrives while Danyel is typing a note or has picked a choice.** That card is left exactly as it is and gains the "this changed, reload it" line. Every other card updates. (Task 8 test `leaves a card being answered alone`.)
4. **A title, ask, question or note containing HTML or a script tag** is shown as those characters. (Task 8 test `page code never writes HTML`, plus the element-builder test.)
5. **The PR that was replaced closes.** The record must not end, because the replacing PR now carries it. And a watcher started on an issue number must still find answers after a PR is attached. (Task 2 tests `a replaced PR closing doesn't end the record` and `finds a record by its issue after a PR is attached`.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/work.ts` | The model: gates, states, the record type, the rules for a new status (`applySet`), questions, choices, answer checks. Pure. |
| `src/shared/view.ts` | Builds the board view (sections, everything list, gate boxes, tags) from records, answers and GitHub facts. Pure, used by the Worker; its types are used by the page. |
| `src/shared/names.ts` | Keeps timings, label names and code-written asks; old status markers removed. |
| `migrations/0001_work.sql` | D1 tables. |
| `src/worker/store.ts` | Every D1 read and write. One function per operation; writes are one `batch` each, so each is atomic. |
| `src/worker/access.ts` | Who is calling: `'owner'`, `'claude'` or null. |
| `src/worker/github.ts` | Reads GitHub facts for repos and record numbers; sets labels. No comments, reactions or status text. |
| `src/worker/labels.ts` | Which managed labels an item should have. |
| `src/worker/api.ts` | The `/api/…` routes: parse, check caller, call the store, answer JSON. |
| `src/worker/index.ts` | Routing, page shell, headers, cache of GitHub facts. |
| `src/page/*.ts` | The browser script: draw, send, refresh, keys. Built to `dist/page/app.js`. |
| `cli/board.ts` | The Mac side's client for `/api/…`: URL, service token, ⚠️ errors. |
| `cli/pr-status.ts`, `cli/watch-answers.ts`, `cli/answers.ts`, `cli/mac-service.ts`, `hooks/status-check.ts` | Rewritten onto `cli/board.ts`. |
| `cli/remove-old-status.ts` | Clears the old status sections and comments at the switch. |

Removed by the end: `src/shared/status.ts`, `fingerprint.ts`, `answer.ts`, `stage.ts`, `turn.ts`, `src/worker/board.ts`, `post-answer.ts`, `render.ts`, and their tests and fixtures that only they use.

---

### Task 1: The model

**Files:**
- Create: `src/shared/work.ts`
- Create: `test/work.test.ts`
- Modify: `src/shared/names.ts` (add the label and choice names; leave old exports until Task 13)

**Interfaces:**
- Produces:
  ```ts
  export const GATES = ['design', 'implementation', 'prep'] as const; export type Gate = typeof GATES[number];
  export const STATES = ['working', 'paused', 'complete', 'parked'] as const; export type State = typeof STATES[number];
  export interface Question { n: number; text: string; choices: string[]; defaultChoice: string }
  export interface WorkRecord {
    id: number; repo: string; issue: number | null; pr: number | null;
    hasDesign: boolean; gate: Gate; state: State; reached: Gate;
    ask: string; questions: Question[]; toTest: string | null; backReason: string | null;
    approved: Partial<Record<'design' | 'implementation', string>>;   // ISO time of each approval
    rounds: Record<Gate, number>; prepSha: string | null;
    version: number; turnSince: string; writtenAt: string; confirmedAt: string | null;
    startedAt: string; endedAt: string | null; endedHow: 'merged' | 'closed' | null;
  }
  export interface SetInput { gate: Gate; state: State; ask: string; questions: string[]; toTest: string | null; reason: string | null; noDesign: boolean; headSha: string | null; isPr: boolean }
  export function parseQuestion(text: string, n: number): Question            // "text (**a** | b)"; throws without exactly one bold default
  export function applySet(prev: WorkRecord | null, input: SetInput, now: string): Omit<WorkRecord, 'id' | 'repo' | 'issue' | 'pr' | 'startedAt' | 'endedAt' | 'endedHow' | 'confirmedAt'> // throws Refused
  export class Refused extends Error {}
  export const APPROVAL_CHOICES: Record<'design' | 'implementation', readonly [string, string]> // ['approve, build it','needs changes'], ['looks good, prep for merge','needs changes']
  export function turnOf(state: State): 'owner' | 'claude' | 'nobody'   // paused|complete → owner, working → claude, parked → nobody
  export interface AnswerInput { version: number; choices: Record<string, string>; approval: string | null; note: string }
  export function checkAnswer(r: WorkRecord, a: AnswerInput): string | null   // the refusal text, or null
  export function gatesOf(r: Pick<WorkRecord, 'hasDesign'>): Gate[]
  export interface AnswerRow { id: number; workId: number; version: number; at: string; choices: Record<string, string>; approval: string | null; note: string; claimedAt: string | null; claimedBy: 'session' | 'service' | null; stateBefore: State | null; gaveUpAt: string | null }
  ```
  `AnswerRow` lives here, not in the store, because the view, the page and the CLI all read it.

- [ ] **Step 1: Write the failing tests** in `test/work.test.ts`, using a `record(over)` helper that builds a `WorkRecord` at implementation/working, version 3:
  - `parseQuestion('Colour? (**red** | green)', 1)` gives `{ n: 1, text: 'Colour?', choices: ['red','green'], defaultChoice: 'red' }`; with no bold, or two bold, it throws.
  - `applySet(null, {gate:'design',state:'working',…}, now)` gives version 1, `reached: 'design'`, `hasDesign: true`, rounds all 0, `turnSince: now`.
  - `applySet(null, {gate:'implementation', noDesign:true,…})` gives `hasDesign: false`. Starting at `prep` throws `Refused`.
  - Moving from `design` to `implementation` while `approved.design` is unset throws `Refused` (message names the gate). The same holds for `implementation` → `prep`.
  - Moving back (`implementation` → `design`) without `reason` throws. With a reason it clears `approved.design` and `approved.implementation`, keeps `reached: 'implementation'`, and stores `backReason`.
  - Each of these throws: `paused` with no questions; `complete` at implementation with no `toTest`; `parked` with an empty ask; `gate: 'prep'` with `isPr: false`; any field containing `\n`.
  - Setting `complete` adds 1 to `rounds[gate]`. Setting `working` adds nothing.
  - `prep` + `complete` stores `prepSha = input.headSha`, and throws when `headSha` is null.
  - Each call gives `version = prev.version + 1`. `turnSince` changes only when `turnOf` changes.
  - `checkAnswer` refuses each of these:
    - a stale `version`;
    - a choice not among the question's choices, or for a question that doesn't exist;
    - an `approval` when the state isn't `complete` or the gate is `prep`;
    - `needs changes` with an empty note;
    - a note over `NOTE_MAX` (2000).
  - `checkAnswer` accepts a note-only answer in any state.
- [ ] **Step 2: Run** `pnpm -C <worktree> test test/work.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/shared/work.ts` with the signatures above. Question parsing takes the trailing `(… | …)` group and splits on `|`. A choice in `**…**` is the default.
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `pnpm -C <worktree> typecheck`. Expected: no errors.
- [ ] **Step 5: Commit** "The workflow model: three gates, four states, and the rules for a new status".

### Task 2: The store

**Files:**
- Create: `migrations/0001_work.sql`, `src/worker/store.ts`, `test/sqlite-d1.ts`, `test/store.test.ts`

**Interfaces:**
- Consumes: Task 1's `WorkRecord`, `SetInput`, `applySet`, `AnswerInput`, `checkAnswer`, `Refused`.
- Produces:
  ```ts
  export interface Db { prepare(sql: string): Stmt; batch(stmts: Stmt[]): Promise<unknown[]> }   // the part of D1Database used
  export interface Stmt { bind(...v: unknown[]): Stmt; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> }
  export interface ItemRef { repo: string; n: number }
  export type Actor = 'status' | 'answer' | 'claim' | 'service' | 'switch-over'
  export function findWork(db: Db, ref: ItemRef): Promise<WorkRecord | null>                // by PR or issue number, open records only
  export function setStatus(db: Db, ref: ItemRef, input: SetInput & { issue: number | null; replaces: number | null }, now: string): Promise<{ record: WorkRecord; handedOver: boolean }>
  export function confirm(db: Db, ref: ItemRef, now: string): Promise<WorkRecord>            // throws Refused when no record
  export function addAnswer(db: Db, ref: ItemRef, a: AnswerInput, now: string): Promise<AnswerRow>   // throws Refused with checkAnswer's text
  export function unclaimedAnswers(db: Db, refs: ItemRef[]): Promise<{ record: WorkRecord; answers: AnswerRow[] }[]>
  export function unclaimedOlderThan(db: Db, before: string): Promise<{ record: WorkRecord; answers: AnswerRow[] }[]>
  export function claim(db: Db, ref: ItemRef, by: 'session' | 'service', now: string): Promise<{ record: WorkRecord; answers: AnswerRow[] }>   // answers empty when nothing was left to claim
  export function unclaim(db: Db, answerIds: number[]): Promise<void>                       // service only: session failed to start
  export function giveUp(db: Db, answerIds: number[], hint: string, now: string): Promise<void>
  export function serviceClaims(db: Db): Promise<{ record: WorkRecord; answers: AnswerRow[] }[]>   // claimed by service, not given up, record version unchanged since
  export function openWork(db: Db): Promise<{ records: WorkRecord[]; answers: AnswerRow[] }>   // answers: every answer to each record's current version, plus the newest given-up one
  export function endWork(db: Db, workId: number, how: 'merged' | 'closed', now: string): Promise<void>
  export function importWork(db: Db, ref: ItemRef, r: Omit<WorkRecord, 'id' | 'repo' | 'version' | 'endedAt' | 'endedHow' | 'confirmedAt'>, now: string): Promise<WorkRecord>   // refuses when a record exists
  ```
- Tables (in `migrations/0001_work.sql`):
  - `work`: one column per `WorkRecord` field. Questions, approvals and rounds are stored as JSON text.
  - `answer`: one column per `AnswerRow` field, plus `give_up_hint`.
  - `log(id, work_id, at, actor, change)`, where `change` is JSON text.
  - Partial unique indexes on `(repo, pr)` and `(repo, issue)` where `ended_at IS NULL`.

- [ ] **Step 1: Write `test/sqlite-d1.ts`.** `export function sqliteDb(): Db` over `DatabaseSync(':memory:')`, with the migration file applied. `batch` runs inside `BEGIN`/`COMMIT`.
- [ ] **Step 2: Write the failing tests** in `test/store.test.ts`:
  - `setStatus` then `findWork` round-trips every field.
  - The first `set` on a PR whose `issue` has an open record attaches the PR to that record. `findWork` by the issue number then returns it: test `finds a record by its issue after a PR is attached`.
  - `replaces: 7` moves the record from PR 7 to the new PR. Test `a replaced PR closing doesn't end the record`: after the move, `findWork({n: 7})` is null and the record is still open.
  - `handedOver` is true when the turn moves to the owner, and false while it stays there.
  - `addAnswer` stores choices, approval and note. An approval sets `approved[gate]` on the record in the same batch.
  - Test `refuses a second answer with choices to one version`. A second note-only answer to the same version is stored.
  - `claim` sets `claimedAt`/`claimedBy`/`stateBefore` on every unclaimed answer of the record. It sets the record to `working` with ask `WORKING_ASK` (or `SERVICE_WORKING_ASK` for `'service'`), and leaves `version` unchanged. A second `claim` returns `answers: []`.
  - `unclaim` puts the answers back and restores the record's state and ask.
  - `giveUp` marks the answers. It sets the record back to `stateBefore` with ask `GAVE_UP_ASK` and `toTest` set to the hint, and leaves `version` unchanged.
  - `serviceClaims` drops claims whose record version has since moved.
  - Every write adds one `log` row with the right actor.
  - `confirm` on an unknown item throws `Refused`.
  - `importWork` refuses when a record exists.
- [ ] **Step 3: Run** `pnpm -C <worktree> test test/store.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `src/worker/store.ts`. Each write is one `db.batch([...])`. The claim's update carries `WHERE claimed_at IS NULL`, and its record update is conditional on that update having claimed something: run the answer update with `RETURNING id`, then update the record only when rows came back.
- [ ] **Step 5: Run** the tests and `pnpm typecheck`. Expected: PASS, no errors.
- [ ] **Step 6: Commit** "The board's database: records, answers, claims and a log, in D1".

### Task 3: Who is calling

**Files:**
- Modify: `src/worker/access.ts`
- Modify: `test/worker.test.ts` (replace the Access tests; delete the rest of this file's old tests in Task 7)

**Interfaces:**
- Produces: `export type Caller = 'owner' | 'claude'`. `export async function caller(req: Request, env: Env, getKey?: JWTVerifyGetKey): Promise<Caller | null>`. `Env` gains `SERVICE_CLIENT_ID: string` and `DB: Db`.
- The owner is a verified token whose `email` matches `ALLOWED_EMAIL`. Claude is a verified token with no `email` and `common_name === SERVICE_CLIENT_ID`.
- With `ALLOW_LOCAL=1` on hostname `localhost`, the caller is `'claude'` when the request has header `X-Local-Caller: claude`, else `'owner'`.

- [ ] **Step 1: Write failing tests:**
  - an owner token gives `'owner'`;
  - a service token with the right `common_name` gives `'claude'`;
  - a service token with another `common_name` gives null;
  - a token carrying both an email and a matching `common_name` gives `'owner'` only if the email matches, never `'claude'`;
  - an empty `SERVICE_CLIENT_ID` never gives `'claude'`;
  - the local header is ignored off `localhost`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, keeping the existing key handling.
- [ ] **Step 4: Run** the tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** "Access: tell the owner's sign-in from Claude's service token".

### Task 4: GitHub facts and labels

**Files:**
- Modify: `src/worker/github.ts` (rewrite: drop comments, timeline, reactions, answers, status text, files, `postComment`)
- Create: `src/shared/facts.ts` (the `Facts` type only, so `src/shared/view.ts` doesn't import from the Worker)
- Create: `src/worker/labels.ts`
- Modify: `test/github.test.ts`, `test/fixtures/graphql-items.json`, `test/github-fake.ts`
- Modify: `cli/setup-labels.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Facts {   // in src/shared/facts.ts
    repo: string; number: number; kind: 'pr' | 'issue'; title: string; url: string; labels: string[];
    createdAt: string; closedAt: string | null; merged: boolean; lastActivityAt: string;
    // PRs only, else null/false:
    isDraft: boolean; headSha: string | null; headRef: string | null; mergeState: string | null; reviewDecision: string | null;
    checks: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null; behindBase: boolean;
    linkedIssue: number | null; stackedOn: number | null; stackedOnOpen: boolean; previewUrl: string | null; screenshots: string[];
  }
  export function fetchFacts(token: string, want: { repo: string; numbers: number[] }[], now: Date, fetchFn?: typeof fetch): Promise<{ facts: Facts[]; errors: string[] }>
  // want: every repo the token sees (pushed in REPO_WINDOW_DAYS) or that has an open record. Fetches each repo's open PRs, plus every listed number (issue or PR, open or closed).
  export function setLabels(token: string, f: Facts, add: string[], remove: string[], fetchFn?: typeof fetch): Promise<void>
  // labels.ts:
  export const MANAGED_LABELS: readonly string[]   // the six labels in Global Constraints
  export function wantedLabels(card: { gate: Gate | null; turn: 'owner' | 'claude' | 'nobody'; ready: boolean }): string[]
  export function labelChanges(have: string[], want: string[]): { add: string[]; remove: string[] }   // touches only MANAGED_LABELS
  ```
- Keep what still applies: the repo-list query and the 60-day window, the batching of 5 repos per query, `previewUrl` from the Cloudflare comment, screenshots from the body, `Refs #N`/`Stacked on #N` and `closingIssuesReferences`, and the behind-base compare. Comments are still needed for the preview URL only: ask for `comments(last: 20)` with `author{login} body`, and nothing else.
- Add `headRefOid reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}`.

- [ ] **Step 1: Write failing tests:**
  - `fetchFacts` reads `headSha`, `reviewDecision` and `checks` from a recorded response;
  - a number in `want` that is closed comes back with `closedAt` and `merged`;
  - a repo outside the window but listed in `want` is still read;
  - `wantedLabels({gate:'prep', turn:'owner', ready:true})` is `['gate: prep', 'on <owner>', 'ready to merge']`;
  - `parked` comes with turn `nobody`;
  - `labelChanges` never removes `in-progress` or a label the board doesn't manage.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Re-record `graphql-items.json` from torahmap with danyel-claude's token, read-only: `gh api graphql -f query=…` with the new query. Save it with PR #626 in it, whose state is BLOCKED, REVIEW_REQUIRED, SUCCESS.
- [ ] **Step 4: Update `cli/setup-labels.ts`** to create `MANAGED_LABELS` plus `in-progress`. Its test asserts the list.
- [ ] **Step 5: Run** the tests and the typecheck. Expected: PASS.
- [ ] **Step 6: Commit** "GitHub: read only what GitHub owns, and set the board's labels".

### Task 5: The board view

**Files:**
- Create: `src/shared/view.ts`, `test/view.test.ts`, `test/view-helpers.ts`

**Interfaces:**
- Consumes: `WorkRecord`, `AnswerRow`, `Facts`, `turnOf`, `gatesOf`, `APPROVAL_CHOICES`, `FILE_AN_ISSUE`.
- Produces:
  ```ts
  export type BoxLook = 'approved' | 'working' | 'paused' | 'complete' | 'ready' | 'blocked' | 'parked' | 'on-hold' | 'todo'
  export interface GateBox { gate: Gate; look: BoxLook; text: string; round: number | null; badge: string | null }   // badge e.g. '1 question'
  export type AnswerState = 'awaiting-pickup' | 'not-picked-up' | 'picked-up' | 'stalled' | 'service-working' | 'gave-up'
  export interface CardView {
    key: string; repo: string; number: number; title: string; url: string; kind: 'pr' | 'issue';
    version: number | null; boxes: GateBox[]; tag: string; turn: 'owner' | 'claude' | 'nobody';
    waitingSince: string | null; startedAt: string; ask: string; toTest: string | null; backReason: string | null;
    questions: { n: number; text: string; choices: string[]; defaultChoice: string }[];
    approval: { choices: string[]; defaultChoice: string } | null; noteLabel: string;   // 'needs changes' at prep, else 'Note'
    answerState: AnswerState | null; lastAnswer: { at: string; note: string; choices: Record<string, string> } | null;
    links: { pr: string | null; issue: string | null; preview: string | null; merge: string | null }; screenshots: string[];
    labels: { add: string[]; remove: string[] };   // what the Worker should change on GitHub
  }
  export interface BoardView { waiting: CardView[]; onClaude: CardView[]; quiet: CardView[]; everything: CardView[]; errors: string[]; generatedAt: string }
  export function buildView(records: WorkRecord[], answers: AnswerRow[], facts: Facts[], errors: string[], now: Date): BoardView
  export function readyToMerge(r: WorkRecord, f: Facts | undefined): { ready: true } | { ready: false; reason: string }
  ```
- Rules the tests pin:
  - **`readyToMerge` reasons, checked in this order:**
    1. `'no PR'`
    2. `'draft'`
    3. `'after #N'` (stacked on an open PR)
    4. `'commits since prep'` (`prepSha !== headSha`)
    5. `'conflicts'` (DIRTY)
    6. `'rebase first'` (BEHIND or `behindBase`)
    7. `'checks failing'` (UNSTABLE, or checks FAILURE/ERROR)
    8. `'checks still running'` (checks PENDING/EXPECTED)
    9. `'GitHub still checking'` (UNKNOWN)
    10. `'GitHub is blocking the merge'` (BLOCKED, unless review is REVIEW_REQUIRED and checks are SUCCESS or null)

    CLEAN, HAS_HOOKS, or BLOCKED-for-review-only means ready.
  - **Boxes:**
    - Gates before the current one are `approved`.
    - The current gate's look follows the state, except at prep + complete, where it is `ready` or `blocked`, with the reason as `text`. If the current gate has an approval but Claude hasn't moved on, it is `approved`.
    - Later gates up to `reached` are `on-hold`; the rest are `todo`.
    - With `hasDesign` false there is no design box.
    - `round` is shown when it is 2 or more.
    - `paused` gets `badge` `'N question(s)'`.
  - **Tags:** exactly the spec's table. Working tags are `Claude designing` / `Claude building` / `Claude prepping`. Answer states map as follows:
    - `not-picked-up` → `Answered, not picked up`
    - `stalled` → `Picked up, but nothing since`
    - `gave-up` → `A session tried and gave up`
    - `awaiting-pickup` → `Answered, waiting for Claude to pick it up`
    - `picked-up` → `Claude is working on your answers`
    - `service-working` → `Mac session working on it`
  - **Answer state:** comes from the answers to the record's current version.
    - Any unclaimed answer is `awaiting-pickup`, or `not-picked-up` once its age is at least `PICKUP_GRACE_MS`.
    - All answers claimed by the service is `service-working`.
    - All claimed by a session is `picked-up`, or `stalled` once `WORKING_STALLS_MS` has passed since the claim.
    - With none on the current version, a given-up answer on the current version gives `gave-up`.
  - **Sections:**
    - **Waiting on you:** the turn is the owner and there is no answer state; the answer state is `not-picked-up`, `stalled` or `gave-up`; or it is an open PR with no record (tag `No status written`).
    - **On Claude:** any other answer state, or the turn is Claude.
    - **Quiet:** parked, or no activity for 3 days.
    - `waitingSince` is the record's `turnSince`. It is the answer's time for `not-picked-up`, and the claim's time for `stalled` and `gave-up`, so a card is ranked from when it came back, not from when it was first handed over.
    - "Stalled" has one rule now, not two. The old "status not rewritten 10 min after the claim" can't happen any more, because the claim and its status change are one database step.
    - Waiting is ordered oldest `waitingSince` first. `everything` is every open card, ordered by `startedAt` newest first, with PRs that have no record using `createdAt`.
  - **Records closing:** a record whose current PR is merged or closed, or whose issue is closed with no PR, is left out. The Worker ends it (Task 7).
  - **Links:** `merge` is the PR's URL when ready; `issue` is the linked issue.

- [ ] **Step 1: Write failing tests** for each rule above, with one card per spec sketch: #626 ready, #573 paused with 1 question, #580 design complete round 2, and #564 reopened with Implementation on hold. Include `readyToMerge` for every reason, for BLOCKED with REVIEW_REQUIRED+SUCCESS (ready), for BLOCKED with REVIEW_REQUIRED+FAILURE (`checks failing`), and for BLOCKED with CHANGES_REQUESTED (`GitHub is blocking the merge`). Include an everything-order test showing a card doesn't move when its answer state changes.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `buildView`.
- [ ] **Step 4: Run** the tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** "The board view: gate boxes, tags, sections and the steady list".

### Task 6: The API

**Files:**
- Create: `src/worker/api.ts`, `test/api.test.ts`

**Interfaces:**
- Consumes: the Task 2 store functions, `caller`, and `fetchFacts`/`setLabels` (injected).
- Produces: `export function handleApi(req: Request, env: Env, who: Caller, deps: ApiDeps): Promise<Response>`, where `ApiDeps = { now: () => Date; facts: (env: Env, records: WorkRecord[], fresh: boolean) => Promise<{ facts: Facts[]; errors: string[] }>; setLabels: typeof setLabels; waitUntil: (p: Promise<unknown>) => void }`.
- Routes. All bodies and replies are JSON. A refusal is `{ error: string }` with 409 (stale or refused) or 400 (malformed). The wrong caller gets 403.

| Method, path | Caller | Body → reply |
|---|---|---|
| GET `/api/board` | owner | → `BoardView` |
| POST `/api/answer` | owner | `{repo, number, version, choices, approval, note}` → `{ card: CardView }`; on 409 `{ error, card }` |
| POST `/api/status` | claude | `{repo, number, ...SetInput, issue, replaces}` → `{ record, handedOver }` |
| POST `/api/ok` | claude | `{repo, number}` → `{ record }` |
| GET `/api/work?repo=&number=` | claude | → `{ record, answers }` or 404 |
| POST `/api/unclaimed` | claude | `{refs}` or `{olderThanMs}` → `[{ record, answers }]` |
| POST `/api/claim` | claude | `{repo, number, by}` → `{ record, answers }` |
| POST `/api/unclaim`, `/api/gave-up` | claude | `{answerIds, hint?}` → `{}` |
| GET `/api/service-claims` | claude | → `[{ record, answers }]` |
| POST `/api/import` | claude | `{repo, number, record}` → `{ record }` |

- Every POST must:
  - have `Content-Type: application/json`;
  - carry `Origin` equal to the request's own origin when `who` is the owner (the service token's client sends none, and is allowed none);
  - be no larger than 64 KB.
- `/api/status` also needs the PR's head for `prep`/`complete`. It fetches the item's facts fresh, fills in `headSha` and `isPr` itself (the client doesn't send them), and then queues a label sync through `waitUntil`.
- `/api/board` reads the store fresh. Its GitHub facts may come from the 60 s cache. It ends records whose item has closed, and queues label changes only when the facts were fresh.

- [ ] **Step 1: Write failing tests** against `sqliteDb()` and fake facts:
  - each route's happy path;
  - an owner calling a claude route, and the reverse, gets 403;
  - a POST without JSON content type gets 400;
  - an owner POST with a foreign `Origin` gets 403;
  - a stale `version` on answer gets 409 with the fresh card;
  - `/api/status` at prep/complete stores the head from facts;
  - `/api/board` ends a merged record and doesn't list it;
  - labels are queued only on a fresh read.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** "The board's interface: answers from the page, statuses and claims from Claude".

### Task 7: The Worker shell

**Files:**
- Modify: `src/worker/index.ts` (rewrite), `wrangler.toml`, `package.json`, `README.md` (the "Look at the page locally" section only)
- Delete: `src/worker/board.ts`, `src/worker/post-answer.ts`, `src/worker/render.ts`, their tests and the old cases in `test/worker.test.ts`
- Modify: `test/worker.test.ts`

**Interfaces:**
- `GET /` returns a small HTML shell. It has a `<title>`, a `<link rel="stylesheet" href="/app.css">`, a `<script src="/app.js" defer>`, and a `<main id="board">` holding "Loading…".
- `/api/*` goes to `handleApi`. Anything else is 404.
- Headers on the shell and on API replies: the policy from Global Constraints, `Cache-Control: no-store`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`.
- The GitHub facts cache keeps the existing 60 s slot scheme, now keyed on the set of numbers asked for.
- `wrangler.toml` gains:
  - `[[d1_databases]] binding = "DB", database_name = "pr-board", database_id = "<filled at switch-over>", migrations_dir = "migrations"`;
  - `[assets] directory = "dist/page"`;
  - `[build] command = "pnpm build:page"`;
  - `SERVICE_CLIENT_ID` under `[vars]`, as `""` until the switch-over.
- `package.json` gains `esbuild` (the version wrangler already installs, 0.28.2) and `"build:page": "esbuild src/page/main.ts --bundle --format=esm --target=es2022 --outfile=dist/page/app.js && cp src/page/app.css dist/page/app.css"`. Add `dist/` to `.gitignore`.
- README local setup: `pnpm exec wrangler d1 migrations apply pr-board --local` before `pnpm dev`. `.dev.vars` holds danyel-claude's token as `GITHUB_TOKEN`, plus `ALLOW_LOCAL=1`.

- [ ] **Step 1: Write failing tests:**
  - `GET /` gives the shell with the exact policy header;
  - `GET /api/board` with no Access token gives 403;
  - an unknown path gives 404;
  - `POST /` gives 405.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, and delete the old Worker modules and their tests.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: PASS. The old shared modules still compile, because the CLI still uses them until Tasks 9–12.
- [ ] **Step 5: Commit** "Worker: a page shell, the API, D1 and static assets; the server-drawn page is gone".

### Task 8: The page

**Files:**
- Create: `src/page/main.ts` (start-up, refresh loop, keys), `src/page/draw.ts` (cards, rows and sections from `BoardView`), `src/page/el.ts` (the only way elements are made), `src/page/merge.ts` (pure: what to replace on refresh), `src/page/form.ts` (pure: form state to `AnswerInput`, dirtiness), `src/page/app.css`
- Create: `tsconfig.page.json` (`include: ["src/page/**/*", "src/shared/**/*"]`, `lib: ["ES2022", "DOM"]`), added to `pnpm typecheck`
- Create: `test/page.test.ts`

**Interfaces:**
- Consumes: `BoardView`, `CardView`, `AnswerInput` and the API routes from Task 6.
- Produces:
  ```ts
  // el.ts
  export function el(doc: Document, tag: string, attrs?: Record<string, string>, ...children: (Node | string | null)[]): HTMLElement   // strings become text nodes; attrs set with setAttribute; refuses attribute names starting "on" and href/src values not starting "https:" or "/"
  // form.ts
  export interface FormState { choices: Record<string, string>; approval: string | null; note: string; touched: boolean }
  export function initialForm(c: CardView): FormState          // defaults chosen, touched false
  export function toAnswer(c: CardView, s: FormState): AnswerInput
  // merge.ts
  export function plan(oldCards: Map<string, CardView>, next: BoardView, touched: Set<string>): { redraw: string[]; flagChanged: string[]; add: string[]; remove: string[] }
  ```
- Behaviour:
  - **Two views.** The view switch writes `?view=turn` or `?view=everything` into the address with `history.replaceState`, and is read back from it on load. The default is `turn`.
  - **Sending.** Send shows "Sending…" and disables the card's button. On 200 the card is redrawn from the reply. On 409 it is redrawn from `card`, with the error shown on it. On a network failure or 5xx, the form is kept and the error is shown.
  - **Refreshing.** It runs every 30 s, and only while `document.visibilityState === 'visible'`; it also runs once when the tab becomes visible. Its outcome is drawn as `merge.plan` decides. A failed refresh shows "Couldn't refresh; last updated HH:MM" at the top.
  - **Keys.** Ctrl+Enter or Cmd+Enter inside a card sends that card.
  - **What every card shows.** Every card has a note box. Questions are radio groups with the default pre-chosen and marked. A complete gate's approval is a radio group, with `needs changes` revealing that the note is required.
  - **Ready cards** show "Merge on GitHub →" as a link to `links.merge`.
  - **Colours** are as in the spec: blue for working and paused, an amber badge, amber for complete, green for ready, red for blocked, grey for parked, and dimmed for on hold. They are defined as CSS custom properties, with a dark variant.

- [ ] **Step 1: Write failing tests** (node, with no DOM: `el` gets a fake `Document` recording `createElement`/`createTextNode`/`setAttribute`):
  - `el(doc,'p',{}, '<script>x</script>')` creates one text node with that exact string;
  - `el` refuses `onclick` and `href="javascript:…"`;
  - test `page code never writes HTML`: reads every file under `src/page/` and asserts none contains `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`;
  - `initialForm` picks each default;
  - `toAnswer` maps it;
  - test `leaves a card being answered alone`: `plan` with that key in `touched` and a changed card puts it in `flagChanged`, not `redraw`;
  - unchanged cards are in neither list;
  - new and removed keys land in `add`/`remove`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` and `pnpm build:page`. Expected: PASS, and `dist/page/app.js` exists.
- [ ] **Step 5: Try it in Chrome.**
  - Seed the local D1 from a fixture with `pnpm exec wrangler d1 execute pr-board --local --file test/fixtures/seed.sql`. Create that file with the four spec cards.
  - Start `pnpm dev` as a tracked background task, read its port, and `curl` it.
  - Open it, then check:
    1. The four cards look as in the spec.
    2. Sending an answer updates the card in place.
    3. A note typed and left unsent survives a refresh.
    4. The view switch keeps its place across a reload.
    5. Ctrl+Enter sends.
    6. The console shows no policy violations.
  - Screenshot each card state into the scratchpad for the PR.
- [ ] **Step 6: Commit** "The page: drawn in the browser, live, and never turning outside text into HTML".

### Task 9: The Mac side's client, and `pr-status`

**Files:**
- Create: `cli/board.ts`, `test/board-client.test.ts`
- Modify: `cli/pr-status.ts` (rewrite), `test/pr-status.test.ts` (rewrite), `pr-board.config.json` and `test/fixtures/pr-board.config.json` (add `"boardUrl"`), `src/shared/config.ts` (export `BOARD_URL`)

**Interfaces:**
- Produces:
  ```ts
  export interface BoardDeps { fetch: typeof fetch; readFile: (p: string) => string; env: NodeJS.ProcessEnv; home: string }
  export class BoardError extends Error {}   // message always starts '⚠️ '
  export function boardCall<T>(deps: BoardDeps, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>
  // the token file: $PR_BOARD_ACCESS_FILE or ~/.config/pr-board/access-token.json, {"clientId": "...", "clientSecret": "..."}; sent as CF-Access-Client-Id / CF-Access-Client-Secret
  // a 409 or 400 reply throws Refused (from work.ts) with the board's error text, which isn't a ⚠️ failure
  ```
- `pr-status set <ref> --gate --state [--ask] [--question]… [--to-test] [--reason] [--no-design] [--replaces <N>] [--issue <N>]`. It posts `/api/status`.
  - When `handedOver` is true it asks `OWNER_LOGIN` to review through `gh` (unchanged code), and prints what went wrong if that fails.
  - The issue is found from the PR body's `Closes #N`/`Refs #N` through `gh` when `--issue` isn't given.
- `pr-status ok <ref>` posts `/api/ok`. `pr-status show <ref>` prints `/api/work` as JSON.
- `pr-status import <ref> --json <file>` posts `/api/import`. It is for the switch-over only, and its help text says so.

- [ ] **Step 1: Write failing tests:**
  - `boardCall` sends both Access headers;
  - test `says the service token was refused when Access answers with HTML`: a 302 or a `text/html` reply throws `BoardError` naming the token file;
  - a missing token file throws `BoardError` saying how to create it;
  - a network error throws `BoardError` with the URL;
  - `set` refuses locally a line break or a question with no bold default (before any call);
  - `set` posts the right body;
  - `set` with `handedOver` asks for review;
  - `ok` and `show` call the right routes;
  - a `Refused` prints the board's text and exits 1.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Question parsing reuses `parseQuestion`.
- [ ] **Step 4: Run** the tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** "pr-status writes to the board, with a gate and a state".

### Task 10: The watcher

**Files:**
- Modify: `cli/watch-answers.ts`, `cli/answers.ts` (rewrite), `test/watch-answers.test.ts` (rewrite)

**Interfaces:**
- Consumes: `boardCall`, and the `/api/unclaimed {refs}` and `/api/claim` routes.
- Produces: `export function describe(record: WorkRecord, answers: AnswerRow[]): string` in `cli/answers.ts`. It gives the item, each question's text with the choice, the approval if any, and the note, indented.
- Loop, unchanged in shape:
  1. Poll `POLL_MS`.
  2. On finding answers, wait `COLLECT_MS`, then claim each item with `by: 'session'`.
  3. Print `describe` for each claim that returned answers, then exit 0.
  4. Back off on errors with `backoff`, and never exit on an error.
  5. Exit when every watched item's record has ended (an `/api/work` 404 for all).
- `refuseOwner` stays, since the session's `gh` must still be Claude's for the review request.

- [ ] **Step 1: Write failing tests:**
  - it claims and prints;
  - a claim that returns no answers (another session got there) doesn't exit;
  - errors back off and don't exit;
  - an issue ref finds answers after a PR was attached (the board resolves it; fake the reply);
  - `describe`'s text for an approval with a note.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** "The watcher asks the board for answers and claims them there".

### Task 11: The Mac service

**Files:**
- Modify: `cli/mac-service.ts`, `test/mac-service.test.ts`, `mac/service.example.json` (no new settings: the board token file is the shared default)

**Interfaces:**
- Consumes: `boardCall`, and the `/api/unclaimed {olderThanMs}`, `/api/claim {by:'service'}`, `/api/unclaim`, `/api/gave-up`, `/api/service-claims` and `/api/work` routes. `describe` comes from Task 10.
- Replace each GitHub-based step:

| Step | Before | After |
|---|---|---|
| Finding answers | `waitingAnswers` per repo | `/api/unclaimed` with `olderThanMs = graceMs` |
| Claiming | 🚀 then 👀 | `/api/claim` with `by: 'service'` (atomic, and writes `SERVICE_WORKING_ASK`) |
| Taking a claim back | `unreact` | `/api/unclaim` |
| Giving up | 😕 plus `writeCodeStatus` | `/api/gave-up` with the log hint |
| Restart recovery | reading items for the service's statuses | `/api/service-claims`; any with no running session is given up |

- Keep unchanged:
  - the process-list detection;
  - the worktree rules, including the PR branch read through `gh`;
  - every check that can fail running before the claim;
  - the time limit and the limit on sessions;
  - the dry run;
  - the stopping rules;
  - log lines that start with the item.
- `strayRockets` and its handling are deleted.

- [ ] **Step 1: Rewrite the tests** that used reactions onto the board fake:
  - claims only after the worktree and prompt are ready;
  - a failed start unclaims;
  - a session ending with the version unchanged gives up;
  - a session ending after a new status does nothing;
  - a restart gives up orphaned claims;
  - the dry run makes no POST.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** "Mac service: answers and claims come from the board; no more reactions".

### Task 12: The end-of-turn hook

**Files:**
- Modify: `hooks/status-check.ts`, `test/status-check.test.ts`

**Interfaces:**
- Consumes: `boardCall`, `/api/work`.
- Keep the transcript parsing and the touched-item detection exactly as they are. Replace `isUpdated` with `GET /api/work`.
  - The item passes when `record.writtenAt` or `record.confirmedAt` is after the turn started.
  - With no record, it blocks with "has no status on the board; run pr-status set".
  - When the board can't be reached, it blocks with the `BoardError` text. If the same failure already blocked this turn once, it lets the stop through, so a dead board can't trap the session. It tells the two cases apart by the hook input's `stop_hook_active`.
- Delete `checkedRefs` and the `~/.pr-board/checked.jsonl` reading.

- [ ] **Step 1: Write failing tests:**
  - written this turn passes;
  - confirmed this turn passes;
  - a write before the turn blocks;
  - no record blocks;
  - the board unreachable blocks once with ⚠️;
  - with `stop_hook_active` true it passes.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** "The end-of-turn hook checks the board, not GitHub".

### Task 13: Clear out the old design, and the switch-over tools

**Files:**
- Delete: `src/shared/status.ts`, `fingerprint.ts`, `answer.ts`, `stage.ts`, `turn.ts`, `src/shared/types.ts` (if nothing imports it) and their tests; the helpers in `cli/gh.ts` only they used (`readStatusText`, `readItem`, `issueComments`); `WRITTEN_ELSEWHERE` entries no longer read; `WAITING_ON`
- Create: `cli/remove-old-status.ts`, `test/remove-old-status.test.ts`
- Modify: `skill/pr-status/SKILL.md` (rewrite for `--gate`/`--state`, notes at any time, approvals with notes, `--replaces`, `--no-design`, the answer handling table from the spec); `README.md` (steps 1, 2, 4–9 for the token, the service token and its policy, D1 and the token file; drop `docs/questions.md` references that no longer apply); `docs/superpowers/specs/2026-11-05-pr-board-design.md` (one line at the top saying which sections the new design replaces)

**Interfaces:**
- `node cli/remove-old-status.ts [--dry-run] <owner/repo> …` goes through every open PR and issue.
  - On a PR whose description holds the old `<!-- status -->…<!-- /status -->` block, it removes the block.
  - On an issue, it deletes danyel-claude's comments that begin with the block.
  - It prints one line per change, and makes none with `--dry-run`.
  - The marker strings it looks for are written in this file, since `status.ts` is gone.

- [ ] **Step 1: Write the failing tests** for `remove-old-status`: a block is removed and the rest of the body kept; Danyel's comments are never deleted; the dry run makes no write.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement it.** Delete the old modules, then run `pnpm typecheck` and fix every import in one pass.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` and `pnpm build:page`. Expected: all pass. Then run `grep -rn "fingerprint\|👀\|statusText\|on danyel" src cli hooks`. Expected: no hits outside `names.ts` and the label list.
- [ ] **Step 5: Rewrite the skill and README text.** Plain English, no coined terms. The `pr-status` skill also says when to write each gate. Starting to brainstorm or design is `--gate design --state working`, or `--no-design` on the first status when there is no design step. The brainstorming skill belongs to a plugin and isn't edited, so this rule lives in `pr-status`.
- [ ] **Step 6: Commit** "Remove the GitHub status section and answer comments; add the switch-over clean-up".

### Task 14: Open the PR, then switch over with Danyel

These steps are not code. Each one that changes something outside the repo waits for Danyel's yes in chat.

- [ ] **Step 1: Run the prep-for-merge skill on the branch.** That means rebase, the two reviews, fixes, and the review comment. Then open the PR with the Task 8 screenshots embedded, closing #17, #19, #20 and #21. Close #22 unmerged, with a comment pointing at the new PR. Hand it to Danyel the old way: a GitHub review request, since the new board isn't live yet.
- [ ] **Step 2: Ask Danyel to do his part, after he merges:**
  1. Create an Access service token with "never" expiry, if he prefers.
  2. Add a Service Auth policy for it on the pr-board application.
  3. Give Claude the client id for `SERVICE_CLIENT_ID`, and put the id and secret into `~/.config/pr-board/access-token.json` (mode 600) himself.
  4. Approve `pnpm exec wrangler d1 create pr-board` and migrations apply.
  5. Approve replacing the Worker's `GITHUB_TOKEN` secret with danyel-claude's token.
- [ ] **Step 3: Deploy, with his yes.** Run `pnpm exec wrangler d1 migrations apply pr-board --remote`, then `pnpm exec wrangler deploy`. Check that `/` loads and `/api/board` answers with no records. Run `node cli/setup-labels.ts --dry-run`, then for real.
- [ ] **Step 4: The one-off pass.**
  1. Read every open PR and labelled issue in the covered repos.
  2. Propose a table: item, gate, state, approvals, ask.
  3. Wait for Danyel to approve it.
  4. Run `pr-status import` per row.
  5. Run `remove-old-status.ts --dry-run`, show him the output, then run it for real.
- [ ] **Step 5: Update `~/.claude/skills/prep-for-merge/SKILL.md`, with his yes, since it is outside the repo.** It should start with `pr-status set --gate prep --state working`. It should end with `--state complete`, or with `--state paused` and questions. The `🤖 Claude: prep for merge` comment comes out of step 8, and the "Reviewed up to" review comment stays.
- [ ] **Step 6: Restart the Mac service** with `launchctl kickstart -k gui/$(id -u)/local.pr-board.mac-service`. Watch its log for one poll. Re-link the skill if its path changed.
- [ ] **Step 7: Check torahmap#626 on the live board.** It should show green "Ready to merge", or red with a true reason. Report what each card shows.
