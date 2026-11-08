# Answering from the board: plan

Date: 2026-11-08. The design is `docs/superpowers/specs/2026-11-05-pr-board-design.md`, "Answers getting back to Claude" and "Settled for answering".

What this adds: the owner answers Claude's questions (and the look question) on the page, the Worker posts the answers as one comment from the owner's account, the board shows the item as answered, and a watcher started by the Claude session that handed the item over picks the answer up.

Each task is written test-first and committed on its own. `pnpm test` and `pnpm typecheck` pass before every commit.

## 1. A fingerprint of what was asked

`src/shared/fingerprint.ts`: a small SHA-256 that runs the same in the Worker and in Node without `await` (the board is built synchronously), and `statusFingerprint(status | null)`, the first 8 hex digits of SHA-256 over the ask and the questions (number, text, choices, default). Whose turn it is and since when are left out, so handing the same questions back keeps the same fingerprint.

Test: SHA-256 of "" and "abc" match the published values; the fingerprint changes when the ask, a question, a choice or the default changes, and not when `waitingOn` or `since` does; a missing status has a fingerprint too.

## 2. The status as data as well as text

`renderStatus` adds one line inside the markers, `<!-- status-data {...} -->`, holding the same fields as JSON plus the fingerprint. `<` and `>` in the JSON are written as `<` and `>`, so no value can end the comment or the section. `parseStatus` uses the data when it is there, reads as JSON of the right shape and its fingerprint matches its content; otherwise it reads the text as today.

Tests: round trip; the data line is there; data wins over text that disagrees; broken JSON, a wrong shape or a wrong fingerprint fall back to the text; old sections with no data line still read; a question text holding `-->` or a status marker can't break the section.

## 3. The answer comment format

`src/shared/answer.ts`, used by the Worker and the watcher: the look question and its choices, `asksForLook(facts, status)` (the owner's turn, a PR, not merged, prep not done), `checkAnswer(status, asksLook, form)` (choices must be listed ones or "file an issue", the note within its limit and without status markers, something must be sent), `renderAnswer` (machine-readable first line, then readable lines) and `parseAnswer`.

Tests: render then parse gives the same answer; a comment that only looks similar, or has a broken first line, parses as null; each refusal of `checkAnswer`; the readable part has one line per question with the answer in bold, the look line and the note.

## 4. Reading answers and claims from GitHub

`fetchItems` reads, for each item, the owner's answer comments written after the status was last written. Comment ids come in the existing query; for the few items that have such answers, one more query reads their 👀 reactions by id. A claim is a 👀 from anyone but the owner. If that query fails, the board says so and treats those answers as not picked up. The owner's answer comments no longer count as a change that makes the status look out of date. `fetchItem` reads one item with the same fields, for the Worker to check before it posts.

Tests (recorded GitHub data, edited): an answer after the status write is found, with its claim; one from someone else, or before the write, is not; the reactions query is made only when needed; a failed reactions query gives an error line and unclaimed answers; the answer doesn't make the status stale; `fetchItem` returns a PR's and an issue's facts, and null for an item the token can't see.

## 5. The board's answered states

A card whose answers are all picked up goes to "On Claude" as "Claude picked up your answers". One with an answer not picked up goes to "On Claude" as "answered, waiting for Claude to pick it up" for 10 minutes, then back to "Waiting on you" tagged "Answered, not picked up".

Tests: each of the three states, at 9 and 11 minutes; an item with no answers is unchanged.

## 6. The page: forms and the look question

Waiting cards with questions, or at Your look, get a form posting to `/answer`: each question's choices plus "file an issue" as radio buttons with the default checked and standing out, the look question at Your look, a note box and Send answers. With no answer token, Send is disabled with a note saying answering isn't set up. After a post, the page says what was sent.

Tests: the form fields and hidden values; default checked; the look question only at Your look; no form for cards with neither; Send disabled without the token; the confirmation is escaped; the answered states' rows and tag.

## 7. POST /answer

Behind the Access check; Origin must be the page's own; form posts only; body at most 16 KB; repo, number and choices checked; the item re-read with the read token, refused if it can't be seen, is closed, or its fingerprint has changed; the comment posted with `GITHUB_ANSWER_TOKEN`; then a 303 back to `/?sent=…`, with the cached board dropped. CSP gains `form-action 'self'`.

Tests: one per refusal, a good post (the comment body and the token used), the redirect, the cache dropped, the CSP.

## 8. The watcher

`cli/watch-answers.ts <owner/repo#N> [...]`: polls once a minute for unclaimed answers from the owner on those items; on finding one waits a minute more, claims each with 👀, prints them with whether the fingerprint matches the current status, and exits 0. It never exits on a timer or an error: errors go to stderr and it retries with a backoff capped at 5 minutes. Time, sleep and `gh` are passed in.

Tests: finds an answer after some polls and claims it; ignores claimed ones, other people's and comments without the format; collects a second answer that arrives during the wait; reports a mismatched fingerprint; keeps going through errors with growing then capped waits; bad arguments exit 1 at once.

## 9. Words

The skill (start the watcher after handing over; what to do with each answer), README (the answer token as a going-live step), `docs/questions.md` (the token question) and the spec ("Settled for answering", and the next parts).

## 10. Check it for real

`wrangler dev` with the read token and no answer token: the page renders with the look question, Send disabled, no error lines.
