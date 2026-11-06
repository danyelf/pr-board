# PR Board, part 1: a board you can read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Danyel opens one page and sees every PR and issue waiting on him (with stage strip, links, test protocol and questions), the quiet ones, and a timeline of the last week, all read from GitHub; and Claude has a helper plus a hook that keep each item's status section and turn label current.

**Architecture:** Pure TypeScript modules in `src/shared/` parse the status section, work out whose turn it is, infer the stage strip, and build the timeline. A Cloudflare Worker (`src/worker/`) fetches items from GitHub's GraphQL API with a token, turns them into those shared shapes, and renders server-side HTML. A small CLI (`cli/pr-status.ts`) writes status sections and labels through `gh`, and a Claude Code Stop hook (`hooks/status-check.ts`) checks that a turn that touched a PR or issue updated it. Answering, the watcher, the Mac service, activity, File an issue and Pick up are parts 2 and 3, not this plan.

**Tech Stack:** TypeScript, Node 24 (runs `.ts` directly via type stripping), pnpm, vitest, Cloudflare Workers + wrangler 4, `jose` for verifying Cloudflare Access tokens, `gh` CLI for the helper and hook.

**Spec:** `docs/superpowers/specs/2026-11-05-pr-board-design.md`

## Global Constraints

- The PR is the unit; the issue stands in until a PR exists. Never the session.
- Labels: `in-progress` (existing, unchanged meaning: picked up by anyone), `on danyel` (Danyel's turn), `parked` (waiting on something outside the two of them). Whose turn: `on danyel` → Danyel; else `parked` → nobody; else `in-progress` → Claude; else none.
- Stage names, fixed, in this order: `Issue`, `Design`, `Build`, `Claude review`, `Your look`, `Merge`.
- Status section lives between `<!-- status -->` and `<!-- /status -->` at the top of the PR description; on an issue with no PR it lives in one Claude comment, edited in place. Never rewrite text outside the markers.
- Every question has a default, written in bold among its choices: `(**leave** | change)`.
- Timeline: real clock time; any stretch of 24 hours or more with no activity is cut to a narrow break; a bar crossing a cut carries its true length as a label (e.g. `waited 1 d 16 h`). Times shown in Pacific time (`America/Los_Angeles`).
- Repos covered: every repo the token can see (viewer's repositories with affiliation OWNER or COLLABORATOR, pushed in the last 60 days).
- Claude's own GitHub writes go through `gh` as configured (danyel-claude via `GH_TOKEN`). The Worker uses its own token secret `GITHUB_TOKEN`.
- No ticket or stage references in code comments. Plain-English copy on the page.
- Commits authored as `Claude (for Danyel) <danyel@gmail.com>`; Danyel is committer. End messages with the Co-Authored-By / Claude-Session lines from the session.
- Nothing outward-facing without Danyel: no `wrangler deploy`, no label creation on real repos, no secrets, no edits to `~/.claude/settings.json`. Tasks that need these stop at a prepared command and record it in `docs/questions.md`.

## Review Focus

1. **A PR with no status section, or a hand-mangled one** (every PR today): the card still renders, with "No status written yet" and whatever facts GitHub gives; parsing never throws. → test in Task 1 (`parseStatus` on garbage and on half-sections) and Task 6 (board with a status-less item).
2. **Danyel edited the PR description since Claude last wrote it**: the helper replaces only the text between markers and keeps every other byte; with no markers it inserts the section at the very top followed by a blank line. → test in Task 1 (`replaceStatus`).
3. **The hook fails or can't reach GitHub** (offline, `gh` not logged in, a turn with no GitHub commands, a re-run after it already blocked once): it never blocks because of its own failure, and never blocks twice in a row (`stop_hook_active`). → tests in Task 4.
4. **One repo errors or the token can't read something**: the page renders the rest and shows a one-line notice naming what failed. → test in Task 5 (partial GraphQL errors) and Task 6.
5. **Timeline edges**: no activity in the window; a quiet stretch of exactly 24 h (is cut); 23 h 59 m (not cut); a bar that starts before the window; times across a daylight-saving change. → tests in Task 3.

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts, wrangler.toml, .gitignore
src/shared/types.ts        shared shapes (below)
src/shared/status.ts       parse / render / replace the status section
src/shared/turn.ts         whose turn from labels
src/shared/stage.ts        stage strip from facts
src/shared/timeline.ts     lanes, segments, gap cutting
src/worker/github.ts       GraphQL fetch → ItemFacts[]
src/worker/board.ts        ItemFacts[] → Board (sections, cards, timeline)
src/worker/render.ts       Board → HTML string
src/worker/access.ts       Cloudflare Access JWT check
src/worker/index.ts        fetch handler
cli/pr-status.ts           helper Claude runs
cli/setup-labels.ts        creates the two new labels in every visible repo
hooks/status-check.ts      Stop hook
skill/pr-status/SKILL.md   instructions for Claude, installed later with Danyel's OK
docs/questions.md          questions for Danyel collected while building
test/**                    vitest tests; test/fixtures/*.json recorded GraphQL responses
```

### Shared shapes (`src/shared/types.ts`, Task 1)

```ts
export type Turn = 'danyel' | 'claude' | 'nobody' | 'none';
export interface Question { n: number; text: string; choices: string[]; defaultChoice: string | null }
export interface Status {
  waitingOn: 'Danyel' | 'Claude' | 'nobody';
  since: string | null;          // ISO 8601 with offset
  ask: string;
  questions: Question[];
  toTest: string | null;
}
export interface LabelEvent { label: string; action: 'added' | 'removed'; at: string }
export interface ItemFacts {
  repo: string; number: number; kind: 'pr' | 'issue'; title: string; url: string;
  labels: string[]; body: string; createdAt: string; closedAt: string | null;
  merged: boolean; mergedAt: string | null; mergeState: string | null; // GitHub mergeStateStatus
  linkedIssue: number | null; stackedOn: number | null;
  previewUrl: string | null; addedDocs: string[]; screenshots: string[];
  reviewSha: string | null; reviewUrl: string | null; commitsSinceReview: number | null;
  prepDone: boolean; statusCommentBody: string | null; // issues only
  labelEvents: LabelEvent[]; lastActivityAt: string;
}
export type BoxState = 'done' | 'now' | 'ready' | 'todo';
export interface StageBox { name: 'Issue' | 'Design' | 'Build' | 'Claude review' | 'Your look' | 'Merge'; state: BoxState; note: string }
```

---

### Task 1: Project setup and the status section

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/shared/types.ts`, `src/shared/status.ts`
- Test: `test/status.test.ts`

**Interfaces:**
- Produces: the types above; `parseStatus(text: string): Status | null`; `renderStatus(s: Status): string`; `replaceStatus(body: string, s: Status): string`; `extractToTest(body: string): string | null`.

The exact section format (from the spec):

```
<!-- status -->
**Waiting on:** Danyel, since 2026-11-02T16:40:00-08:00
**Ask:** look at the preview, and answer one question
**Questions:**
1. Does the tint over the code dull the colours enough to change the shell?  (**leave** | change)
**To test:** pin a verse, leave the mouse on it, press Escape: the popup stays up, unpinned.
<!-- /status -->
```

`Waiting on:` is `Danyel`, `Claude` or `nobody`, optionally followed by `, since <ISO>`. `Questions:` and `To test:` lines are optional. A question line matches `^(\d+)\.\s+(.*?)\s+\((.+)\)\s*$`; choices split on ` | `; the one wrapped in `**` is the default (stored without the asterisks). A question line without a trailing parenthesis has `choices: []`.

- [ ] **Step 1: Scaffold.** `pnpm init`; add dev deps `typescript vitest wrangler @cloudflare/workers-types`, dep `jose`; scripts `test: vitest run`, `typecheck: tsc --noEmit`, `dev: wrangler dev`. `tsconfig` with `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"allowImportingTsExtensions": true`, `"noEmit": true`, `"strict": true`, types `@cloudflare/workers-types`. `.gitignore`: `node_modules`, `.wrangler`, `.dev.vars`.
- [ ] **Step 2: Write failing tests** in `test/status.test.ts`:
  - `parseStatus` on the example above → `{ waitingOn: 'Danyel', since: '2026-11-02T16:40:00-08:00', ask: 'look at the preview, and answer one question', questions: [{ n: 1, text: 'Does the tint over the code dull the colours enough to change the shell?', choices: ['leave', 'change'], defaultChoice: 'leave' }], toTest: 'pin a verse, …unpinned.' }`.
  - the same section embedded after other text and before other text still parses.
  - `parseStatus('no markers here')` → `null`; a section with markers but no `Waiting on:` line → `null`; an unclosed `<!-- status -->` → `null`; none of these throw.
  - `renderStatus(parseStatus(x)!)` round-trips to an equal `Status`.
  - `replaceStatus(body, s)` where `body` = `"A\n<!-- status -->\nold\n<!-- /status -->\nB\n\n## Rest"` → keeps `"A\n"` before and `"\nB\n\n## Rest"` after byte-for-byte.
  - `replaceStatus('Closes #569\n\nText', s)` → `renderStatus(s) + '\n\nCloses #569\n\nText'`.
  - `extractToTest` returns the text after `**To look at on the preview:**` up to the next blank line (Torahmap's existing convention), or `null`.
- [ ] **Step 3: Run** `pnpm test` → FAIL (module missing).
- [ ] **Step 4: Implement** `src/shared/types.ts` and `src/shared/status.ts`.
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck` → PASS, no type errors.
- [ ] **Step 6: Commit** `Status section: parse, render, replace`.

### Task 2: Whose turn, and the stage strip

**Files:**
- Create: `src/shared/turn.ts`, `src/shared/stage.ts`
- Test: `test/turn.test.ts`, `test/stage.test.ts`

**Interfaces:**
- Consumes: `ItemFacts`, `Status`, `StageBox` (Task 1).
- Produces: `turnOf(labels: string[]): Turn`; `stageStrip(f: ItemFacts, s: Status | null): StageBox[]` (always six boxes, in the fixed order); `whyTag(f: ItemFacts, s: Status | null): string`.

Rules for `stageStrip` (box → state, note):
- **Issue**: `done`, note `#<linkedIssue>` when `linkedIssue`, else for `kind: 'issue'` note `#<number>`; `todo` otherwise.
- **Design**: `done` with note `✓` when `addedDocs.length > 0`, or note `<n> mockups` when `screenshots.length > 0`; for issues, `now` when turn is `danyel` and there is no PR; else `todo`.
- **Build**: `done` (`✓`) for any PR; `todo` for issues.
- **Claude review**: `done` when `reviewSha` or `prepDone`; note `✓ prep done` when `prepDone`, else `✓`, else (if `commitsSinceReview > 0`) `✓ <n> commits since`.
- **Your look**: `now` when turn is `danyel` and not ready-to-merge; note = `<k> questions` when the status has k>0 questions, else wait time (`1 d 16 h`, computed from `status.since` or the last `on danyel` added event). `done` when `prepDone` and turn is not `danyel` or when merged. Else `todo`.
- **Merge**: `done` when merged; `ready` when `prepDone` and turn is `danyel` and the status has no questions; note `after #<stackedOn>` when `stackedOn`, `rebase first` when `mergeState === 'BEHIND'`, the wait time when `ready`.

`whyTag`: `Ready to merge` when Merge is `ready`; `<k> decisions + your look` when k>0; `Only your look is left` when Your look is `now`; `Parked` for turn `nobody`; else `''`.

- [ ] **Step 1: Write failing tests.** `turnOf`: `['on danyel','in-progress']`→`danyel`; `['parked','in-progress']`→`nobody`; `['in-progress']`→`claude`; `[]`→`none`. `stageStrip`: build facts for 573 as it stood on 2026-11-05 (linkedIssue 569, reviewSha `bd275212`, commitsSinceReview 1, labels `['on danyel']`, mergeState `BEHIND`, status with 0 questions) → states `['done','done','done','done','now','todo']`, Merge note `rebase first`; 574 (stackedOn 573, 2 questions) → Your look note `2 questions`, Merge note `after #573`, whyTag `2 decisions + your look`; 578 (prepDone, `on danyel`, 0 questions) → Merge `ready`, whyTag `Ready to merge`; an issue with `on danyel` and no PR → Design `now`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Wait times format as `<d> d <h> h`, `<h> h`, or `<m> min`, from a `now: Date` parameter (add `now = new Date()` as the last optional argument of `stageStrip` and `whyTag` so tests are deterministic).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `Whose turn and the stage strip`.

### Task 3: Timeline

**Files:**
- Create: `src/shared/timeline.ts`
- Test: `test/timeline.test.ts`

**Interfaces:**
- Consumes: `ItemFacts`, `LabelEvent`.
- Produces:
  ```ts
  export type SegKind = 'working' | 'waiting' | 'ready' | 'parked' | 'merged';
  export interface Segment { kind: SegKind; start: number; end: number; trueLength?: string } // start/end: 0..1 across the axis
  export interface Lane { label: string; url: string; segments: Segment[] }
  export interface Cut { at: number; width: number; length: string }        // where a ≥24 h quiet stretch was removed
  export interface Tick { at: number; text: string }                        // axis labels, Pacific time
  export interface Timeline { lanes: Lane[]; cuts: Cut[]; ticks: Tick[]; openCount: { at: number; n: number }[] }
  export function buildTimeline(items: ItemFacts[], now: Date, days?: number): Timeline // days default 7
  ```

Rules:
- Window: `now - days` to `now`. An item is in it if it was open at any point in the window.
- Per item, walk its `labelEvents` (sorted) from `createdAt` to `mergedAt ?? closedAt ?? now`: `waiting` while `on danyel` is on (`ready` instead when `prepDone` and the stretch is the last one); `parked` while `parked` is on; `working` otherwise. Merged items that lived under 6 hours are one `merged` segment. With no label events, one `working` segment.
- Activity instants for cutting = every label event, `createdAt`, `mergedAt`, `closedAt` of every item, plus `now`. Any gap between consecutive instants of ≥ 24 h (exactly 24 h counts) is cut: it gets a fixed width of 0.03 of the axis, the remaining width is shared linearly by real time. A segment overlapping a cut whose real span is ≥ 24 h gets `trueLength` (`waited 1 d 16 h` for `waiting`, `<d> d <h> h` otherwise).
- Ticks at each local midnight (America/Los_Angeles) not inside a cut, text like `Wed 0:00`; use `Intl.DateTimeFormat` with `timeZone`, never fixed offsets.
- `openCount`: number of items open, sampled at every instant.

- [ ] **Step 1: Write failing tests.** (a) Two items, no gap → `cuts` empty, segments positioned linearly. (b) A 38 h quiet stretch → one cut with `length: '1 d 14 h'`, a `waiting` segment across it has `trueLength: 'waited 1 d 16 h'` when its real span is 40 h. (c) exactly 24 h → cut; 23 h 59 m → not cut. (d) item created before the window → its first segment starts at 0. (e) window spanning 2026-11-01 (DST end) → ticks read `Sun 0:00`, `Mon 0:00` at the right local midnights. (f) no items → `lanes: []`, no throw.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `Timeline with long quiet stretches cut out`.

### Task 4: The helper Claude runs, the label setup, and the Stop hook

**Files:**
- Create: `cli/gh.ts` (thin wrapper: `gh(args: string[]): Promise<string>` using `child_process.execFile('gh', …)`), `cli/pr-status.ts`, `cli/setup-labels.ts`, `hooks/status-check.ts`, `skill/pr-status/SKILL.md`, `docs/questions.md`
- Test: `test/pr-status.test.ts`, `test/status-check.test.ts`

**Interfaces:**
- Consumes: `parseStatus`, `renderStatus`, `replaceStatus` (Task 1).
- Produces (commands; `<ref>` is `owner/repo#N` or `#N` resolved against the cwd's `origin`):
  - `node cli/pr-status.ts set <ref> --waiting danyel|claude|nobody [--ask "<text>"] [--question "<text> (**a** | b)"]… [--to-test "<text>"]` — writes the section (PR: description via `gh api -X PATCH repos/{o}/{r}/pulls/{n} -f body=…`; issue: finds the existing comment containing `<!-- status -->` by this user and edits it, else creates one), and sets labels: `danyel` → add `on danyel`, remove `parked`; `nobody` → add `parked`, remove `on danyel`; `claude` → remove both. `since` is set to now when `waitingOn` changes, kept otherwise.
  - `node cli/pr-status.ts ok <ref>` — records "status checked, still correct" by appending `{ref, at}` to `~/.pr-board/checked.jsonl`.
  - `node cli/pr-status.ts show <ref>` — prints the parsed status as JSON.
  - `node cli/setup-labels.ts [--dry-run]` — for each repo the `gh` user can see (OWNER/COLLABORATOR, pushed in the last 60 days), creates `on danyel` (colour `e8a33a`, description `Waiting on Danyel: a look, an answer, or a merge`) and `parked` (colour `c9c6bd`, description `Waiting on something outside Danyel and Claude`) when missing. Prints what it would do with `--dry-run`.
  - `hooks/status-check.ts` reads the Stop hook JSON on stdin (`session_id`, `transcript_path`, `cwd`, `stop_hook_active`) and prints `{"decision":"block","reason":"…"}` or nothing.

Hook rules:
- If `stop_hook_active` is true → print nothing, exit 0.
- Find the turn: transcript lines after the last entry with `type: "user"` whose `message.content` is a string (Danyel's typed message); turn start = that entry's `timestamp`.
- Touched items: from `Bash` tool calls in the turn, `gh pr (create|comment|edit|merge|review) <n|url>`, `gh issue (create|comment|edit) <n|url>`, `gh api …/(pulls|issues)/<n>…` with `-X PATCH|POST`, and `git push` (resolve the pushed branch's PR with `gh pr list --head <branch> --json number`). Skip calls to `cli/pr-status.ts` itself.
- For each touched item, it counts as updated if: the description (PR) or status comment (issue) `updated_at` ≥ turn start and contains `<!-- status -->`, or a label event for `on danyel`/`parked` is ≥ turn start, or `~/.pr-board/checked.jsonl` has the ref at ≥ turn start.
- Block reason text: `You changed <refs> this turn but didn't update their status. Run: node <abs path>/cli/pr-status.ts set <ref> --waiting … (or "ok <ref>" if the status is still right).`
- Any error (no `gh`, offline, unreadable transcript) → write one line to stderr, print nothing, exit 0.

- [ ] **Step 1: Write failing tests.** `pr-status`: with `gh` injected as a fake that records calls, `set acme/x#5 --waiting danyel --ask "look" --question "Colour? (**red** | green)"` on a PR issues one PATCH whose body begins with the rendered section and preserves the old body after it, and label calls add `on danyel` and remove `parked`; running it twice with the same `waitingOn` keeps the first `since`. `status-check`: fixture transcripts in `test/fixtures/transcripts/` for (a) a turn with `gh pr comment 574` and no status update → block naming `danyelf/torahmap#574`; (b) same turn plus a later `pr-status.ts set` → no block (fake `gh` reports a fresh `updated_at`); (c) a turn with no GitHub commands → nothing; (d) `stop_hook_active: true` → nothing; (e) fake `gh` throws → nothing, stderr has one line.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Make `gh` injectable (`main(argv, deps = { gh, now, home })`) so tests don't touch the network.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Write `skill/pr-status/SKILL.md`**: when handing any PR or issue back to Danyel, or picking one up, run `pr-status set`; every question gets a bold default; put the test protocol in `--to-test`; if a turn changed nothing about the ask, run `pr-status ok`. Description line: `Use when handing a PR or issue back to Danyel, asking him a question about one, or starting work on one.`
- [ ] **Step 6: Record in `docs/questions.md`** (do not run): the `setup-labels.ts` real run; the settings.json snippet that registers the hook as a second `Stop` entry (`{"type":"command","command":"node /Users/danyel/code/MISC/pr-board/hooks/status-check.ts"}`); symlinking the skill into `~/.claude/skills/pr-status`. Run `node cli/setup-labels.ts --dry-run` and paste its output there.
- [ ] **Step 7: Commit** `Status helper, label setup and the Stop hook`.

### Task 5: Reading GitHub

**Files:**
- Create: `src/worker/github.ts`
- Test: `test/github.test.ts`, `test/fixtures/graphql-*.json`

**Interfaces:**
- Consumes: `ItemFacts`, `LabelEvent`, `extractToTest` is not needed here.
- Produces: `fetchItems(token: string, now: Date, fetchFn?: typeof fetch): Promise<{ items: ItemFacts[]; errors: string[] }>`.

What it fetches (GraphQL, `https://api.github.com/graphql`, header `Authorization: bearer <token>`, `User-Agent: pr-board`):
1. `viewer.repositories(first: 100, ownerAffiliations: [OWNER, COLLABORATOR], orderBy: {field: PUSHED_AT, direction: DESC})`; keep those pushed within 60 days.
2. Per repo (batched with aliases, at most 10 repos per query): open PRs, PRs merged or closed within the last 7 days, and open issues labelled `in-progress`, `on danyel` or `parked`. For each: number, title, url, body, labels, createdAt, closedAt, merged, mergedAt, mergeStateStatus, headRefName, `closingIssuesReferences(first:1)`, `files(first:100){path changeType}`, `commits(last:100){commit{oid committedDate}}`, `comments(last:50){author{login} body url updatedAt}`, `timelineItems(last:100, itemTypes:[LABELED_EVENT, UNLABELED_EVENT]){… label{name} createdAt}`.

Mapping to `ItemFacts`:
- `linkedIssue`: first closing reference, else `/Refs #(\d+)/` in the body.
- `stackedOn`: `/Stacked on #(\d+)/i` in the body.
- `previewUrl`: in a comment containing `Branch Preview URL`, the `href` of that link (`/href='(https:\/\/[^']+)'>Branch Preview URL/`); else `null`.
- `addedDocs`: added `.md` files under `docs/`.
- `screenshots`: image URLs in the body: `![…](url)` and `<img src="url">`.
- `reviewSha`/`reviewUrl`: the last comment matching ``/Reviewed up to `([0-9a-f]{7,40})`/``; `commitsSinceReview` = commits after the one whose oid starts with that sha (null if not found).
- `prepDone`: any comment containing `🤖 Claude: prep for merge`.
- `statusCommentBody` (issues): the last comment containing `<!-- status -->`.
- `lastActivityAt`: latest of comment `updatedAt`, commit date, label event, createdAt.

- [ ] **Step 1: Record fixtures.** With `gh api graphql` run the two queries against Danyel's account once, save trimmed responses to `test/fixtures/graphql-repos.json` and `test/fixtures/graphql-items.json` (keep torahmap 573, 574, 578, 564 and issue 563; drop other repos' data). This is a read; no writes.
- [ ] **Step 2: Write failing tests** with a fake `fetchFn` serving the fixtures: 573 maps to `linkedIssue: 569`, `reviewSha: 'bd275212'`, `commitsSinceReview: 1`, `previewUrl: 'https://panels-unchanged-torahmap.danyel.workers.dev'`; 574 has `stackedOn: 573`; 578 has `prepDone: true` and two screenshots; issue 563 is present with label `in-progress`. A response with `errors: [{message: 'Could not resolve to a Repository'}]` for one alias still returns the other repos' items and `errors` names it. A non-200 response returns `{ items: [], errors: ['GitHub said 401 …'] }`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** `Read PRs and issues from GitHub`.

### Task 6: The board and its page

**Files:**
- Create: `src/worker/board.ts`, `src/worker/render.ts`, `src/worker/access.ts`, `src/worker/index.ts`, `wrangler.toml`
- Test: `test/board.test.ts`, `test/render.test.ts`, `test/worker.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export interface Card { facts: ItemFacts; status: Status | null; strip: StageBox[]; why: string; waited: string; toTest: string | null }
  export interface Board { waiting: Card[]; onClaude: Card[]; quiet: Card[]; timeline: Timeline; errors: string[]; generatedAt: string }
  export function buildBoard(items: ItemFacts[], errors: string[], now: Date): Board
  export function renderBoard(b: Board): string
  export async function checkAccess(req: Request, env: Env): Promise<boolean>
  export interface Env { GITHUB_TOKEN: string; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; ALLOWED_EMAIL: string }
  ```

Rules:
- Status for a PR comes from its body; for an issue from `statusCommentBody`. `toTest` = `status.toTest ?? extractToTest(body)`.
- Merged/closed items appear only on the timeline.
- `waiting`: turn `danyel`, oldest wait first. `onClaude`: turn `claude`, most recent activity first. `quiet`: turn `nobody`, plus open items with turn `claude` or `none` and no activity for 3 days (these leave `onClaude`).
- When an issue has an open PR that closes it, show only the PR.
- Render: server-side HTML, inline CSS taken from `docs/mockups/board-v3.html` (cards with stage strip, links Preview / PR / Claude's review / Issue, test protocol, questions with their choices shown as buttons with the default visibly emphasised and a final `file an issue` choice — buttons are display-only in this part, disabled with title "Answering comes next"), quiet rows, an "On Claude" list of compact rows (number, title, last activity), and the timeline (timeline A look, cuts drawn as narrow striped bands labelled with their length). A card with no status shows `No status written yet` in place of the ask. Errors show as one notice line at the top. Must work at phone width (single column, no horizontal scroll, 16 px side gutter). Escape all GitHub text.
- `checkAccess`: verify the `Cf-Access-Jwt-Assertion` header with `jose.jwtVerify` against `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (remote JWKS), audience `ACCESS_AUD`, and require `email === ALLOWED_EMAIL`. Missing or bad → 403.
- `index.ts`: `GET /` → access check → `fetchItems` → `buildBoard` → `renderBoard`, `Cache-Control: no-store`; GitHub results cached in the Cache API for 60 s keyed by the minute.
- `wrangler.toml`: name `pr-board`, `workers_dev = false`, a commented-out route `board.danyelfisher.info` (to confirm with Danyel), `compatibility_date` = today.

- [ ] **Step 1: Write failing tests.** `buildBoard` on the Task 5 fixture items at `now = 2026-11-05T23:59:00Z`: `waiting` numbers `[573, 574, 578]` in that order (all labelled `on danyel` in the fixture — edit the fixture labels to match the spec's example if they aren't), `quiet` contains 564; an item with no status still gets a card with `status: null`. `renderBoard`: contains `#573`, `Only your look is left`, `panels-unchanged-torahmap.danyel.workers.dev`, the test-protocol text, `No status written yet` for a status-less card, `&lt;script&gt;` when a title contains `<script>`, and the default choice rendered with the emphasis class. `worker`: request without the Access header → 403; with a header signed by a local test key (inject the JWKS) and the right email → 200 and HTML.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Look at it.** Run `pnpm dev` with `.dev.vars` holding `GITHUB_TOKEN=$(gh auth token)` and a dev-only bypass `ALLOW_LOCAL=1` that skips `checkAccess` when the request host is `localhost` (and only then; test that it is ignored for any other host). Screenshot with headless Chrome at 1200 px and 390 px wide; save to `docs/mockups/part1-desktop.png` and `part1-phone.png`; compare against `board-v3.png` and fix anything clearly off.
- [ ] **Step 6: Commit** `The board page`.

### Task 7: Hand-off notes for going live

**Files:**
- Modify: `docs/questions.md`, create `README.md`

- [ ] **Step 1:** In `README.md`: what this is (two paragraphs, plain English), how to run tests and the local page, and the go-live steps: create a fine-grained token (read: metadata, contents, issues, pull requests; write: issues, pull requests) and `wrangler secret put GITHUB_TOKEN`; set up a Cloudflare Access application for the chosen hostname with Danyel's Google login and copy its AUD into `wrangler.toml` vars; `wrangler deploy`; run `setup-labels.ts`; install the hook and skill; the one-off pass proposing `on danyel` / `parked` for open items.
- [ ] **Step 2:** In `docs/questions.md`, list each go-live step as a question for Danyel with the exact command prepared, plus anything the build turned up.
- [ ] **Step 3: Commit** `README and go-live questions`.
