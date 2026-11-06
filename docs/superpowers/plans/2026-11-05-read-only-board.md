# PR Board, part 1: a board you can read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Danyel opens one page and sees every PR and issue waiting on him (with stage strip, links, test protocol and questions), what Claude is on, the quiet ones, and a timeline of the last week, all read from GitHub; and Claude has a helper plus a hook that keep each item's status section and turn label current.

**Architecture:** Pure TypeScript modules in `src/shared/` parse the status section, work out whose turn it is, infer the stage strip, and build the timeline. A Cloudflare Worker (`src/worker/`) fetches items from GitHub's GraphQL API with a token, turns them into those shared shapes, and renders server-side HTML. A small CLI (`cli/pr-status.ts`) writes status sections and labels through `gh`, and a Claude Code Stop hook (`hooks/status-check.ts`) checks that a turn that touched a PR or issue updated it. Answering, the watcher, the Mac service, activity, File an issue and Pick up are parts 2 and 3, not this plan.

**Tech Stack:** TypeScript, Node 24 (runs `.ts` directly via type stripping), pnpm, vitest, Cloudflare Workers + wrangler 4, `jose` for verifying Cloudflare Access tokens, `gh` CLI for the helper and hook.

**Spec:** `docs/superpowers/specs/2026-11-05-pr-board-design.md`

## Global Constraints

- The PR is the unit; the issue stands in until a PR exists. Never the session.
- Labels: `in-progress` (existing, unchanged meaning: picked up by anyone), `on danyel` (Danyel's turn), `parked` (waiting on something outside the two of them). Whose turn from labels: `on danyel` → Danyel; else `parked` → nobody; else `in-progress` → Claude; else none.
- **The page must never show something as fine when it is waiting on Danyel.** Where labels and the status section disagree, the item is treated as waiting on Danyel if either says so, and the card says "label out of sync". Items with no turn label are shown as such, never as "Claude working".
- Stage names, fixed, in this order: `Issue`, `Design`, `Build`, `Claude review`, `Your look`, `Merge`.
- Status section lives between `<!-- status -->` and `<!-- /status -->` at the top of the PR description; on an issue with no PR it lives in one Claude comment, edited in place. Never rewrite text outside the markers. `since` is ISO 8601 with offset; the page shows it in Pacific time.
- Every question has a default, written in bold among its choices: `(**leave** | change)`.
- Timeline: real clock time; any stretch of 24 hours or more with no activity is cut to a narrow break; a bar crossing a cut carries its true length as a label (e.g. `waited 1 d 16 h`). Times in `America/Los_Angeles`, via `Intl`, never fixed offsets.
- Repos covered: every repo the token can see (viewer's repositories with affiliation OWNER or COLLABORATOR, pushed in the last 60 days).
- Claude's own GitHub writes go through `gh` as configured (danyel-claude via `GH_TOKEN`). The Worker uses its own token secret `GITHUB_TOKEN`.
- No ticket or stage references in code comments. Plain-English copy on the page.
- Commits authored as `Claude (for Danyel) <danyel@gmail.com>`; Danyel is committer. End messages with the Co-Authored-By / Claude-Session lines from the session.
- Nothing outward-facing without Danyel: no `wrangler deploy`, no label creation on real repos, no secrets, no edits to `~/.claude/settings.json`, no writes to any GitHub repo. Tasks that need these stop at a prepared command and record it in `docs/questions.md`.

## Review Focus

1. **A PR with no status section, or a hand-mangled one** (every PR today): the card still renders, with "No status written yet" and whatever facts GitHub gives; parsing never throws; question text containing its own parentheses still parses. → Task 1 tests, Task 6 test.
2. **Danyel edited the PR description since Claude last wrote it**: the helper replaces only the text between markers and keeps every other byte; with no markers it inserts the section at the very top followed by a blank line. → Task 1 test (`replaceStatus`).
3. **The hook fails or can't reach GitHub** (offline, `gh` not logged in, a turn with no GitHub commands, a re-run after it already blocked once): it never blocks because of its own failure, and never blocks twice in a row. And it does block when only a comment was posted. → Task 4 tests.
4. **One repo errors or the token can't read something**: the page renders the rest and shows a one-line notice naming what failed; errors are never cached. → Task 5 and Task 6 tests.
5. **Labels and status disagree, or no labels at all** (true of every item on day one): nothing vanishes and nothing waiting on Danyel shows as quiet or "working". → Task 6 tests (#564 with a status saying Danyel but only `in-progress` lands in Waiting with "label out of sync"; an unlabelled recent PR lands in On Claude marked "no turn label").

---

## File structure

```
package.json, tsconfig.json (worker), tsconfig.node.json (cli, hooks, tests), vitest.config.ts, wrangler.toml, .gitignore
src/shared/types.ts        shared shapes (below)
src/shared/status.ts       parse / render / replace the status section
src/shared/turn.ts         whose turn
src/shared/stage.ts        stage strip from facts
src/shared/timeline.ts     lanes, segments, gap cutting
src/worker/github.ts       GraphQL fetch → ItemFacts[]
src/worker/board.ts        ItemFacts[] → Board (sections, cards, timeline)
src/worker/render.ts       Board → HTML string
src/worker/access.ts       Cloudflare Access JWT check
src/worker/index.ts        fetch handler
cli/gh.ts                  injectable wrapper around the gh command
cli/pr-status.ts           helper Claude runs
cli/setup-labels.ts        creates the two new labels in every visible repo; checks merge-commit settings
hooks/status-check.ts      Stop hook
skill/pr-status/SKILL.md   instructions for Claude, installed later with Danyel's OK
docs/questions.md          questions for Danyel collected while building (exists)
test/**                    vitest tests; test/fixtures/** recorded data
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
  isDraft: boolean; merged: boolean; mergedAt: string | null;
  mergeState: string | null;          // GitHub mergeStateStatus, PRs only
  behindBase: boolean;                // PR head is missing commits from its base branch
  linkedIssue: number | null; stackedOn: number | null; stackedOnOpen: boolean;
  previewUrl: string | null; addedDocs: { path: string; url: string }[]; screenshots: string[];
  reviewSha: string | null; reviewUrl: string | null; commitsSinceReview: number | null;
  prepDone: boolean; commitsSincePrep: number | null;
  statusCommentBody: string | null;   // issues only
  labelEvents: LabelEvent[];
  activityTimes: string[];            // commits, comments, label events, created/merged/closed
  lastActivityAt: string;
}
export type BoxState = 'done' | 'now' | 'ready' | 'blocked' | 'todo';
export interface StageBox { name: 'Issue' | 'Design' | 'Build' | 'Claude review' | 'Your look' | 'Merge'; state: BoxState; note: string }
```

---

### Task 1: Project setup and the status section

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vitest.config.ts`, `.gitignore`, `src/shared/types.ts`, `src/shared/status.ts`
- Test: `test/status.test.ts`

**Interfaces:**
- Produces: the types above; `parseStatus(text: string): Status | null`; `renderStatus(s: Status): string`; `replaceStatus(body: string, s: Status): string`; `extractToTest(body: string): string | null`.

The exact section format:

```
<!-- status -->
**Waiting on:** Danyel, since 2026-11-02T16:40:00-08:00
**Ask:** look at the preview, and answer one question
**Questions:**
1. Does the tint over the code dull the colours enough to change the shell?  (**leave** | change)
**To test:** pin a verse, leave the mouse on it, press Escape: the popup stays up, unpinned.
<!-- /status -->
```

`Waiting on:` is `Danyel`, `Claude` or `nobody`, optionally followed by `, since <ISO>`. `Questions:` and `To test:` are optional. A question line is `<n>. <text>` optionally ending in a final parenthesised group that contains ` | `; take the **last** `(…)` group on the line that contains `|` as the choices (so text may contain its own parentheses). Choices split on `|` and trimmed; the one wrapped in `**` is the default (stored without asterisks). No such group → `choices: []`, `defaultChoice: null`.

- [ ] **Step 1: Scaffold.** `pnpm init`; `"type": "module"`. Dev deps `typescript vitest wrangler @cloudflare/workers-types @types/node`; dep `jose`. Scripts: `test: vitest run`, `typecheck: tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json`, `dev: wrangler dev`. Both tsconfigs: `"strict": true`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"allowImportingTsExtensions": true`, `"noEmit": true`, `"verbatimModuleSyntax": true`, `"erasableSyntaxOnly": true`, `"target": "ES2022"`. `tsconfig.json` includes `src/**`, types `@cloudflare/workers-types`. `tsconfig.node.json` includes `src/shared/**`, `cli/**`, `hooks/**`, `test/**`, types `node`. All imports use `.ts` extensions and `import type` for types. `.gitignore`: `node_modules`, `.wrangler`, `.dev.vars`.
- [ ] **Step 2: Write failing tests** in `test/status.test.ts`:
  - `parseStatus` on the example → `{ waitingOn: 'Danyel', since: '2026-11-02T16:40:00-08:00', ask: 'look at the preview, and answer one question', questions: [{ n: 1, text: 'Does the tint over the code dull the colours enough to change the shell?', choices: ['leave', 'change'], defaultChoice: 'leave' }], toTest: 'pin a verse, leave the mouse on it, press Escape: the popup stays up, unpinned.' }`.
  - `1. Tint (over code)? (**a** | b)` → text `Tint (over code)?`, choices `['a','b']`, default `a`.
  - the section embedded between other text still parses.
  - `parseStatus('no markers here')` → `null`; markers but no `Waiting on:` → `null`; unclosed `<!-- status -->` → `null`; none throw.
  - `renderStatus(parseStatus(x)!)` round-trips to an equal `Status`.
  - `replaceStatus("A\n<!-- status -->\nold\n<!-- /status -->\nB\n\n## Rest", s)` keeps `"A\n"` before and `"\nB\n\n## Rest"` after byte-for-byte.
  - `replaceStatus('Closes #569\n\nText', s)` → `renderStatus(s) + '\n\nCloses #569\n\nText'`.
  - `extractToTest` returns the text after `**To look at on the preview:**` up to the next blank line, trimmed, or `null`.
- [ ] **Step 3: Run** `pnpm test` → FAIL (module missing).
- [ ] **Step 4: Implement** `src/shared/types.ts` and `src/shared/status.ts`.
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** `Status section: parse, render, replace`.

### Task 2: Whose turn, and the stage strip

**Files:**
- Create: `src/shared/turn.ts`, `src/shared/stage.ts`
- Test: `test/turn.test.ts`, `test/stage.test.ts`

**Interfaces:**
- Consumes: `ItemFacts`, `Status`, `StageBox` (Task 1).
- Produces:
  - `turnOf(labels: string[]): Turn`
  - `effectiveTurn(labels: string[], s: Status | null): { turn: Turn; outOfSync: boolean }` — turn is `danyel` if `turnOf` says so **or** `s?.waitingOn === 'Danyel'`; otherwise `turnOf`'s answer. `outOfSync` is true when a status exists and `turnOf` (mapped `danyel`↔`Danyel`, `claude`↔`Claude`, `nobody`↔`nobody`, `none`↔anything) disagrees with `s.waitingOn`.
  - `waitingSince(f: ItemFacts, s: Status | null): string | null` — the time of the most recent `on danyel` added event still in force; else `s.since`; else `null`.
  - `isReadyToMerge(f: ItemFacts, s: Status | null): boolean` — PR, not merged, not draft, `prepDone`, `commitsSincePrep === 0`, turn `danyel`, no questions, `mergeState` in `CLEAN` or `HAS_HOOKS`, not `behindBase`, and not `stackedOnOpen`.
  - `stageStrip(f: ItemFacts, s: Status | null, now?: Date): StageBox[]` — always six boxes in the fixed order.
  - `whyTag(f: ItemFacts, s: Status | null, now?: Date): string`
  - `formatWait(fromIso: string, now: Date): string` — `<d> d <h> h`, `<h> h`, or `<m> min`.

Rules for `stageStrip` (turn = `effectiveTurn(...).turn`):
- **Issue**: `done`, note `#<linkedIssue>` (PR) or `#<number>` (issue); `todo` for a PR with no linked issue, note `''`.
- **Design**: `done` when `addedDocs.length > 0` (note `✓`) or `screenshots.length > 0` (note `<n> mockups`); for an issue with turn `danyel`: `now`; else `todo`.
- **Build**: `done` (`✓`) for any PR; `todo` for issues.
- **Claude review**: `done` when `reviewSha` or `prepDone`. Note: `✓ <n> commits since` when the relevant count (`commitsSincePrep` if `prepDone`, else `commitsSinceReview`) is > 0; else `✓ prep done` if `prepDone`; else `✓`. Otherwise `todo`.
- **Your look**: `done` when merged or `prepDone` (prep runs after Danyel's approval). Else `now` when turn is `danyel`, note `<k> questions` if k > 0, else `formatWait(waitingSince)` (or `''` if null). Else `todo`.
- **Merge**: `done` when merged. `ready` when `isReadyToMerge`, note = wait time. Else `blocked` when the PR is otherwise past prep (prepDone, turn danyel) but something holds it, note the first that applies: `draft`, `after #<stackedOn>`, `conflicts` (`DIRTY`), `checks failing` (`UNSTABLE` or `BLOCKED`), `rebase first` (`behindBase` or `BEHIND`), `commits since prep`, `GitHub still checking` (`UNKNOWN`). Else `todo` with the same note list applied for `after #N` and `rebase first` only.

`whyTag`: `Ready to merge` when Merge is `ready`; `Can't merge yet: <note>` when Merge is `blocked`; `<k> decisions + your look` when k > 0 and turn `danyel`; `Only your look is left` when Your look is `now`; `Parked` when turn `nobody`; else `''`.

- [ ] **Step 1: Write failing tests.**
  - `turnOf`: `['on danyel','in-progress']`→`danyel`; `['parked','in-progress']`→`nobody`; `['in-progress']`→`claude`; `[]`→`none`.
  - `effectiveTurn(['in-progress'], status waitingOn Danyel)` → `{ turn: 'danyel', outOfSync: true }`; `(['on danyel'], status waitingOn Claude)` → `{ turn: 'danyel', outOfSync: true }`; `(['on danyel'], null)` → `{ turn: 'danyel', outOfSync: false }`.
  - 573 as of 2026-11-05: `linkedIssue: 569`, `addedDocs: [one]`, `reviewSha: 'bd275212'`, `commitsSinceReview: 1`, labels `['on danyel']`, `behindBase: true`, status with 0 questions → states `['done','done','done','done','now','todo']`, Claude review note `✓ 1 commits since`, Merge note `rebase first`, whyTag `Only your look is left`.
  - 574: `stackedOn: 573`, `stackedOnOpen: true`, status with 2 questions → Your look note `2 questions`, Merge note `after #573`, whyTag `2 decisions + your look`.
  - 578: `prepDone`, `commitsSincePrep: 0`, `on danyel`, 0 questions, `mergeState: 'CLEAN'` → Your look `done`, Merge `ready`, whyTag `Ready to merge`. Same with `mergeState: 'UNSTABLE'` → Merge `blocked` note `checks failing`, whyTag `Can't merge yet: checks failing`. Same with `isDraft: true` → note `draft`.
  - An issue with `on danyel` and no PR → Design `now`.
  - `waitingSince` prefers the label event over a stale `status.since`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `Whose turn and the stage strip`.

### Task 3: Timeline

**Files:**
- Create: `src/shared/timeline.ts`
- Test: `test/timeline.test.ts`

**Interfaces:**
- Consumes: `ItemFacts`, `effectiveTurn`, `isReadyToMerge` (Task 2), `parseStatus`.
- Produces:
  ```ts
  export type SegKind = 'working' | 'waiting' | 'ready' | 'parked' | 'merged' | 'unlabelled';
  export interface Segment { kind: SegKind; start: number; end: number; trueLength?: string } // 0..1 across the axis
  export interface Lane { label: string; url: string; segments: Segment[] }
  export interface Cut { at: number; width: number; length: string }   // a removed ≥24 h quiet stretch
  export interface Tick { at: number; text: string }                   // axis labels, Pacific time
  export interface Timeline { lanes: Lane[]; cuts: Cut[]; ticks: Tick[]; openCount: { at: number; n: number }[] }
  export function buildTimeline(items: ItemFacts[], now: Date, days?: number): Timeline // days default 7
  ```

Rules:
- Window: `now - days` to `now`. An item is in it if open at any point in the window. Callers pass items already de-duplicated (issue with an open PR dropped).
- Per item, walk its sorted `labelEvents` from `createdAt` to `mergedAt ?? closedAt ?? now`: `waiting` while `on danyel` is on; `parked` while `parked` is on; `working` while `in-progress` is on (or the item is a PR whose issue was `in-progress`… keep it simple: while `in-progress` is on); otherwise `unlabelled`. If the item's current status says Danyel but no `on danyel` label is on, the final stretch from `status.since` (or the last activity) to the end is `waiting`. The final stretch is `ready` instead of `waiting` when `isReadyToMerge`. Merged items that lived under 6 hours are one `merged` segment.
- Instants for cutting = every item's `activityTimes` plus `now` and the window start. Any gap between consecutive instants of ≥ 24 h (exactly 24 h counts) is cut: fixed width 0.03 of the axis; the remaining width is shared linearly by real time. A segment overlapping a cut whose real span is ≥ 24 h gets `trueLength` (`waited 1 d 16 h` for `waiting`, `<d> d <h> h` otherwise).
- Ticks at each local midnight (America/Los_Angeles) not inside a cut, text like `Wed 0:00`.
- `openCount`: number of items open, sampled at every instant.

- [ ] **Step 1: Write failing tests.** (a) Two items, no gap → `cuts` empty, linear positions. (b) A 38 h quiet stretch → one cut `length: '1 d 14 h'`; a `waiting` segment spanning 40 h real across it has `trueLength: 'waited 1 d 16 h'`. (c) exactly 24 h → cut; 23 h 59 m → not cut. (d) item created before the window → first segment starts at 0. (e) window spanning 2026-11-01 (DST end) → ticks `Sun 0:00` and `Mon 0:00` sit at the true local midnights. (f) no items → `lanes: []`, no throw. (g) a PR with commits every few hours for two days and no label events → no cuts in those days, one `unlabelled` segment. (h) an item labelled only `in-progress` whose status says Danyel since T → its last segment from T is `waiting`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `Timeline with long quiet stretches cut out`.

### Task 4: The helper Claude runs, the label setup, and the Stop hook

**Files:**
- Create: `cli/gh.ts`, `cli/pr-status.ts`, `cli/setup-labels.ts`, `hooks/status-check.ts`, `skill/pr-status/SKILL.md`
- Modify: `docs/questions.md`
- Test: `test/pr-status.test.ts`, `test/status-check.test.ts`, `test/fixtures/transcripts/*.jsonl`

**Interfaces:**
- Consumes: `parseStatus`, `renderStatus`, `replaceStatus` (Task 1).
- Produces:
  - `cli/gh.ts`: `export type Gh = (args: string[], opts?: { cwd?: string }) => Promise<string>`; `export const gh: Gh` (uses `execFile('gh', …)`, rejects on non-zero exit with stderr in the message).
  - Every script exports `main(argv: string[], deps: { gh: Gh; now: () => Date; home: string }): Promise<number>` and runs it only when executed directly (`if (import.meta.main)`).
  - `<ref>` is `owner/repo#N`, or `#N` resolved against `gh repo view --json nameWithOwner` in the cwd.
  - `pr-status set <ref> --waiting danyel|claude|nobody [--ask "<text>"] [--question "<text> (**a** | b)"]… [--to-test "<text>"]` — reads the item (`gh api repos/{o}/{r}/issues/{n}` tells PR vs issue via `pull_request`); PR: rewrites the description with `replaceStatus` via `gh api -X PATCH repos/{o}/{r}/pulls/{n} -f body=…`; issue: edits the viewer's existing comment containing `<!-- status -->` (`gh api -X PATCH repos/{o}/{r}/issues/comments/{id}`), else creates one. Labels: `danyel` → add `on danyel`, remove `parked`; `nobody` → add `parked`, remove `on danyel`; `claude` → remove both. Removing a label that isn't there (404) is fine. Adding a label missing from the repo prints `Label "on danyel" doesn't exist in <repo>; run cli/setup-labels.ts` and exits 1 after writing the status. `since` = now when `waitingOn` changes, kept otherwise. Every question must have a bold default, else exit 1 with a message saying so.
  - `pr-status ok <ref>` — appends `{"ref":"owner/repo#N","at":"<ISO>"}` to `<home>/.pr-board/checked.jsonl`.
  - `pr-status show <ref>` — prints the parsed status as JSON (or `null`).
  - `setup-labels [--dry-run]` — for each repo the `gh` user can see (OWNER/COLLABORATOR, pushed within 60 days): creates `on danyel` (colour `e8a33a`, description `Waiting on Danyel: a look, an answer, or a merge`) and `parked` (colour `c9c6bd`, description `Waiting on something outside Danyel and Claude`) when missing; and warns for any repo whose `merge_commit_message` or `squash_merge_commit_message` is `PR_BODY`/`BLANK`-vs-body (anything that would copy the PR description into a commit), because the status section would leak into history there. `--dry-run` only prints.
  - `hooks/status-check.ts` reads Stop hook JSON on stdin (`session_id`, `transcript_path`, `cwd`, `stop_hook_active`) and prints `{"decision":"block","reason":"…"}` or nothing; always exits 0.

Hook rules:
- `stop_hook_active` true → print nothing.
- Turn start = timestamp of the last transcript entry with `type: "user"` that is Danyel typing: `message.content` is a string, or an array containing a `text` part, and is not a tool result (no `tool_result` parts) and not a system/notification wrapper (text doesn't start with `<`).
- Touched items, from `Bash` tool_use entries after turn start, each resolved against that entry's own `cwd` and any `-R`/`--repo` flag:
  - `gh pr (comment|edit|review) <n|url>`, `gh issue (comment|edit) <n|url>`;
  - `gh pr create` / `gh issue create`: number from the matching tool_result's URL;
  - `gh api` with `-X PATCH|POST` on a path containing `/pulls/<n>` or `/issues/<n>`;
  - `git push`: branch from `git -C <cwd> rev-parse --abbrev-ref HEAD` (or the explicit refspec), PR from `gh pr list --head <branch> --json number`.
  - Skip `gh pr merge`, `gh pr close`, `gh issue close`, and calls to `pr-status.ts`.
- An item counts as updated if any holds: (PR) GraphQL `lastEditedAt` of the PR ≥ turn start and the body contains `<!-- status -->`; (issue) the status comment's `updated_at` ≥ turn start; a `labeled`/`unlabeled` event for `on danyel` or `parked` ≥ turn start; `checked.jsonl` has the ref at ≥ turn start.
- Block reason: `You changed <refs> this turn but didn't update their status. Run: node /Users/danyel/code/MISC/pr-board/cli/pr-status.ts set <ref> --waiting … (or "ok <ref>" if the status is still right).`
- Any error → one line to stderr, print nothing.

- [ ] **Step 1: Write failing tests** with an injected fake `gh` that records calls and returns canned JSON:
  - `set acme/x#5 --waiting danyel --ask look --question "Colour? (**red** | green)"` on a PR → one PATCH whose body begins with the rendered section and keeps the old body after it; label calls add `on danyel` and remove `parked`; a 404 on removing `parked` still exits 0.
  - running `set` twice with the same `waitingOn` keeps the first `since`; a question without a bold default → exit 1, no PATCH.
  - on an issue with an existing status comment → PATCH to that comment id, not a new comment.
  - `status-check` fixtures: (a) `gh pr comment 574` in `/Users/danyel/code/MISC/torahmap`, PR `lastEditedAt` before turn start → block naming `danyelf/torahmap#574`; (b) the same plus `lastEditedAt` after turn start and body with the marker → nothing; (c) no GitHub commands → nothing; (d) `stop_hook_active: true` → nothing; (e) fake `gh` throws → nothing, one stderr line; (f) `gh pr create` whose tool_result contains `https://github.com/danyelf/torahmap/pull/580` → checks #580; (g) Danyel's message is an image paste plus text (array content) → turn start is that message, not an earlier one; (h) `gh pr merge 576` alone → nothing.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Write `skill/pr-status/SKILL.md`.** Frontmatter `name: pr-status`, description `Use when handing a PR or issue back to Danyel, asking him a question about one, or starting work on one.` Body: run `pr-status set` whenever the turn changes or the ask changes; every question gets choices with one bold default; put the test protocol in `--to-test`; run `pr-status ok` when a turn changed nothing about the ask; use the absolute path `/Users/danyel/code/MISC/pr-board/cli/pr-status.ts`.
- [ ] **Step 6: Record in `docs/questions.md`** (do not run): the real `setup-labels.ts` run (and that it runs as whichever account `gh` uses, which may see different repos than the Worker token); the settings.json snippet adding a second `Stop` entry `{"type":"command","command":"<abs path to node 24> /Users/danyel/code/MISC/pr-board/hooks/status-check.ts"}` (find the path with `command -v node`); symlinking `skill/pr-status` into `~/.claude/skills/pr-status`. Run `node cli/setup-labels.ts --dry-run` (read-only) and paste its output there.
- [ ] **Step 7: Commit** `Status helper, label setup and the Stop hook`.

### Task 5: Reading GitHub

**Files:**
- Create: `src/worker/github.ts`
- Test: `test/github.test.ts`, `test/fixtures/graphql-*.json`

**Interfaces:**
- Consumes: `ItemFacts`, `LabelEvent`.
- Produces: `fetchItems(token: string, now: Date, fetchFn?: typeof fetch): Promise<{ items: ItemFacts[]; errors: string[] }>`.

Queries (POST `https://api.github.com/graphql`, headers `Authorization: bearer <token>`, `User-Agent: pr-board`):
1. `viewer { repositories(first: 100, ownerAffiliations: [OWNER, COLLABORATOR], orderBy: {field: PUSHED_AT, direction: DESC}) { nodes { nameWithOwner pushedAt defaultBranchRef { name } } } }`; keep repos pushed within 60 days.
2. Per repo, batched with aliases (at most 5 repos per query):
   - `pullRequests(first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { …PR } }` — keep open ones and ones merged/closed within 7 days (cut off in code).
   - `issues(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { …Issue } }` — keep those with any of `in-progress`, `on danyel`, `parked` (filter in code; the `labels` argument is AND).
   - PR fragment: `number title url body isDraft createdAt closedAt merged mergedAt mergeStateStatus headRefName baseRefName labels(first:20){nodes{name}} closingIssuesReferences(first:1){nodes{number}} files(first:100){nodes{path changeType}} commits(last:100){nodes{commit{oid committedDate}}} comments(last:100){nodes{author{login} body url createdAt updatedAt}} timelineItems(last:100, itemTypes:[LABELED_EVENT, UNLABELED_EVENT]){nodes{__typename ... on LabeledEvent{label{name} createdAt} ... on UnlabeledEvent{label{name} createdAt}}}`.
   - Issue fragment: the same minus PR-only fields.
3. `behindBase`: for open PRs, REST `GET /repos/{o}/{r}/compare/{base}...{head}` → `behind_by > 0` (at most 20 calls per page load; skip and leave `false` beyond that, adding an error line `Didn't check <n> PRs against main`).

Mapping:
- `linkedIssue`: first closing reference, else `/Refs #(\d+)/` in the body.
- `stackedOn`: `/Stacked on #(\d+)/i`; `stackedOnOpen`: that PR number is among the repo's open PRs.
- `previewUrl`: from a comment containing `Branch Preview URL`, `/href='(https:\/\/[^']+)'>Branch Preview URL/`; else `null`.
- `addedDocs`: files with `changeType: ADDED`, `.md`, under `docs/`; url = `<pr url>/files` (good enough).
- `screenshots`: body image URLs from `![…](url)` and `<img … src="url">`.
- `reviewSha`/`reviewUrl`: the last comment matching ``/Reviewed up to `([0-9a-f]{7,40})`/``; `commitsSinceReview` = number of commits after the one whose oid starts with that sha, `null` if not found among the last 100.
- `prepDone`/`commitsSincePrep`: last comment containing `🤖 Claude: prep for merge`; commits with `committedDate` after that comment's `createdAt`.
- `statusCommentBody` (issues): last comment containing `<!-- status -->`.
- `activityTimes`: createdAt, mergedAt, closedAt, every commit date, comment createdAt, label event; `lastActivityAt` = the latest.
- GraphQL `errors` for one alias → keep the rest, add `Couldn't read <repo>: <message>`. Non-200 → `{ items: [], errors: ['GitHub said <status> <text>'] }`.

- [ ] **Step 1: Record fixtures (read-only).** Run the queries once with `gh api graphql` against Danyel's account; save trimmed responses to `test/fixtures/graphql-repos.json` and `test/fixtures/graphql-items.json` (torahmap PRs 573, 574, 576, 578, 564 and issue 563 only).
- [ ] **Step 2: Write failing tests** with a fake `fetchFn` serving the fixtures: 573 → `linkedIssue: 569`, `reviewSha: 'bd275212'`, `commitsSinceReview: 1`, `previewUrl: 'https://panels-unchanged-torahmap.danyel.workers.dev'`; 574 → `stackedOn: 573`; 578 → `prepDone: true`, two screenshots; issue 563 present with `in-progress`; 576 present as merged. Partial `errors` for one alias → other items still returned and `errors` names the repo. Non-200 → empty items and one error.
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
  export interface Card { facts: ItemFacts; status: Status | null; turn: Turn; outOfSync: boolean; strip: StageBox[]; why: string; waitingSince: string | null; waited: string; toTest: string | null }
  export interface Board { waiting: Card[]; onClaude: Card[]; quiet: Card[]; timeline: Timeline; errors: string[]; generatedAt: string }
  export function buildBoard(items: ItemFacts[], errors: string[], now: Date): Board
  export function renderBoard(b: Board): string
  export interface Env { GITHUB_TOKEN: string; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; ALLOWED_EMAIL: string; ALLOW_LOCAL?: string }
  export async function checkAccess(req: Request, env: Env, getKey?: JWTVerifyGetKey): Promise<boolean>
  export function makeHandler(deps: { fetchItems: typeof fetchItems; cache?: Cache; getKey?: JWTVerifyGetKey; now?: () => Date }): ExportedHandler<Env>
  ```

Rules:
- Status: PR from its body; issue from `statusCommentBody`. `toTest = status?.toTest ?? extractToTest(body)`.
- Drop an issue when an open PR in the same repo has it as `linkedIssue`. Merged/closed items appear only on the timeline.
- `waiting`: effective turn `danyel`; sorted by `waitingSince` ascending, nulls last, ties by number ascending.
- `quiet`: turn `nobody`; plus turn `claude` or `none` with `lastActivityAt` older than 3 days.
- `onClaude`: everything else open (turn `claude`, or `none` with recent activity); most recent activity first. Turn `none` rows say `no turn label`.
- `outOfSync` cards show `label out of sync` next to the why tag.
- Render: server-side HTML, inline CSS from `docs/mockups/board-v3.html`. Top line: `Updated <time PT>` from `generatedAt`, and any error lines. Cards: number, title, why tag, waited, stage strip (`now` amber, `ready` green, `blocked` red-brown, `done` blue-grey), links (Preview, PR, Claude's review, Issue, and `Merge on GitHub` when Merge is `ready`, linking to the PR), test protocol, questions with each choice as a button — the default visibly emphasised (class `default`, bold with a heavier border) and a final `file an issue` choice — all disabled with `title="Answering comes next"`; screenshot thumbnails (max 4, 96 px wide, linked to the image); design doc links; `No status written yet` when status is null. On Claude: one compact row each (number, title, last activity, `no turn label` where applicable). Quiet: one row each, saying `parked` or `no activity for <n> days`. Timeline: timeline A look; `unlabelled` segments light grey; cuts as narrow striped bands labelled with their length; `trueLength` drawn on its bar; an open-at-once strip under the lanes; a legend. Phone width: single column, no horizontal scroll, 16 px side gutter (timeline scrolls inside its own box). Escape all GitHub text.
- `checkAccess`: if `env.ALLOW_LOCAL === '1'` and `new URL(req.url).hostname === 'localhost'` → true. Else verify `Cf-Access-Jwt-Assertion` with `jose.jwtVerify(token, getKey ?? createRemoteJWKSet(new URL('https://' + ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs')), { audience: ACCESS_AUD, issuer: 'https://' + ACCESS_TEAM_DOMAIN })` and require `payload.email === ALLOWED_EMAIL`. Missing or invalid → false.
- Handler: `GET /` → `checkAccess` (false → 403 `Not allowed`) → items from cache (key = minute, 60 s) or `fetchItems`; store in cache only when `errors` is empty → `buildBoard` → `renderBoard`; `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`. `index.ts` default export = `makeHandler({ fetchItems, cache: caches.default })`.
- `wrangler.toml`: name `pr-board`, `main = "src/worker/index.ts"`, `workers_dev = false`, commented route `board.danyelfisher.info` (to confirm with Danyel), `compatibility_date = "2026-11-05"`, vars `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAIL = "danyel@gmail.com"` with placeholder values for the first two.

- [ ] **Step 1: Write failing tests.**
  - `buildBoard` on the Task 5 fixture items at `now = 2026-11-06T00:00:00Z`, with fixture labels edited so 573, 574, 578 carry `on danyel`: `waiting` numbers `[573, 574, 578]` (573 and 574 waiting since 2026-11-04, 578 since 2026-11-05); 564 with status `waitingOn: 'Danyel'` added to its fixture body and labels `[]` → in `waiting` with `outOfSync: true`; issue 563 dropped because 564 closes it; an unlabelled PR active 1 h ago → `onClaude` with turn `none`; an `in-progress` PR inactive 4 days → `quiet`; an item with no status → card with `status: null`.
  - `renderBoard`: contains `#573`, `Only your look is left`, `panels-unchanged-torahmap.danyel.workers.dev`, the 573 test-protocol text, `No status written yet`, `label out of sync`, `no turn label`, `&lt;script&gt;` for a title containing `<script>`, an element with class `default` around the default choice, `file an issue`, `Updated `.
  - `worker` (via `makeHandler` with fakes): no Access header → 403; header signed by a local test key (`jose.generateKeyPair` + `createLocalJWKSet`) with the right email, audience and issuer → 200 HTML; right signature but wrong email → 403; `ALLOW_LOCAL=1` with host `localhost:8787` → 200 without a header; `ALLOW_LOCAL=1` with host `board.example.com` → 403; a `fetchItems` result with errors is not written to the cache.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Look at it.** `.dev.vars` with `GITHUB_TOKEN=<output of gh auth token>` and `ALLOW_LOCAL=1`; run `pnpm dev` as a tracked background task, read the port from its output, `curl -s` it; screenshot with headless Chrome at 1200 px and 390 px wide into `docs/mockups/part1-desktop.png` and `part1-phone.png`; compare with `board-v3.png` and fix anything clearly off. Stop the dev server by its PID.
- [ ] **Step 6: Commit** `The board page`.

### Task 7: Hand-off notes for going live

**Files:**
- Modify: `docs/questions.md`; Create: `README.md`

- [ ] **Step 1:** `README.md`: what this is (two plain paragraphs), how to run tests and the local page, and the go-live steps: create a fine-grained token (repository access: all repositories; read metadata, contents, issues, pull requests) and `wrangler secret put GITHUB_TOKEN`; a Cloudflare Access application for the chosen hostname with Danyel's Google login, its team domain and AUD into `wrangler.toml`; `wrangler deploy`; `setup-labels.ts`; install the hook and skill; the one-off pass proposing `on danyel` / `parked` for open items, for Danyel's approval.
- [ ] **Step 2:** `docs/questions.md`: each go-live step as a question with its exact command, plus anything the build turned up.
- [ ] **Step 3: Commit** `README and go-live questions`.
