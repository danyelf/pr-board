# PR Board: "Find some more" from the backlog

Date: 2026-11-25. Status: draft for Danyel's review. Issue #18.

## The problem

Many open issues have nobody working on them (84 in torahmap today, 6 in pr-board), and the board offers no way to say "start on some of these". Today each one needs a Claude session opened by hand. The first design planned a Backlog list with a **Pick up** button per issue; that was never built.

## What Danyel chose

On the board, on 2026-11-25:

- **C first: Claude proposes the next few.** One button starts a session that reads the backlog and comes back with a card: "here are the ones I'd do next, and why", one question per issue. His answers pick them up. It doubles as a tidy-up, since with this many issues some are likely stale or duplicates.
- **At most 4 sessions open at once.**

The per-issue Pick up button (A) and "pick up the next N" (B) are left for later. Both would reuse the pick-up step below, so either is a small addition afterwards. (A note on B: the issue worried that many issues lack a priority label. In torahmap 83 of the 84 open issues have one, so B is more workable than the issue said.)

![The Backlog with its buttons, the proposal card, and the picked-up issues](../../mockups/find-more.png)

(The issues on the mockup's card are real pr-board issues, but the picks and reasons are only examples; nobody has checked them.)

## How it works, end to end

1. **Danyel presses "Find some more"** on a repo's line in the Backlog section at the foot of the page. The line also says how many open issues in that repo have no record and nobody's `in-progress` label. Above the lines: how many of the 4 sessions are running on the Mac now.
2. **The board writes a request** (repo, time). It refuses a second one for a repo that already has one waiting or running, and the repo's line says "looking through the backlog…" until the proposal card appears.
3. **The Mac service starts a session for the request**, the same way it starts one for answers: `claude -p` with a prompt, as Claude's own GitHub account, counted against the limit of 4. The session only reads, so it runs in a fresh worktree on the default branch and makes no commits.
4. **The session reads the backlog**: the open issues with no record and no `in-progress`, their labels, ages and comments, the recent merged PRs, and earlier proposal cards (so an issue Danyel said "later" to isn't proposed again for two weeks). It picks:
   - up to **5 to pick up**, each with a one-line reason (why this one, why now, what it is close to);
   - any number of **issues to close**, each with a one-line reason (done by an earlier PR, a duplicate of #N, no longer wanted).
5. **The card.** The session writes it as a status, paused, with one question per issue: `#25 Stop hook asks for a status… — reason (**pick up** | later | close)`. Ones to close have **close** as the default. See "Where the card lives" below.
6. **Danyel answers** as on any card: a choice per issue, and a note if he likes ("also #19, and not #24 until #12 is settled").
7. **A session acts on the answers** (the watcher's or the Mac service's, as for any answer):
   - **pick up**: it asks the board to pick the issue up (a new `pr-status pick-up <ref>` command). The issue gets the `in-progress` label and a card of its own in On Claude, "Picked up, waiting for a free session".
   - **close**: it closes the issue on GitHub with a comment giving the reason and a link to the card's issue.
   - **later**: nothing, apart from being remembered (step 4).
   - Then it ends the proposal card (see below).
8. **The Mac service starts a session for each pick-up** when one of the 4 is free, oldest first, with answers waiting going ahead of pick-ups, so an item Danyel answered isn't stuck behind new work. The session is told: Danyel picked this up from the backlog; start with design (`--gate design --state working`), and end with design complete or paused with questions. It uses the worktree and branch `issue-N`, as today. Its first status replaces "waiting for a free session" with the normal card.

## The pieces to build

- **Board database**: a request table (kind: proposal or pick-up, repo, issue for a pick-up, when made, when a session took it, when it ended). Pressing the button and `pr-status pick-up` each add a row.
- **Board HTTP interface**: Danyel's sign-in may make a proposal request; the service token may make a pick-up, list waiting requests, and claim one (one safe update, as answers are claimed). The page's data gains the Backlog counts per repo and the number of sessions running (the Mac service reports it on each look).
- **The page**: the Backlog section, its button, "looking through the backlog…", the session count, and the "waiting for a free session" card.
- **The Mac service**: serves requests as well as answers, raises the default limit from 2 to 4, and writes two new prompts (proposal, pick-up). Its existing rules carry over unchanged: nothing claimed before the worktree and prompt are ready, a session that dies without writing a status is handed back to Danyel, the hour limit.
- **The status command**: `pr-status pick-up <ref>`.
- **The pr-status skill**: a short section on what a proposal session and a pick-up session must do.

## Where the card lives

The board's record is for one piece of work with an issue or a PR. A proposal card is neither, so it needs a home. Two ways:

- **(a) A proposal issue on GitHub** (my pick). The session opens an issue, "Next from the backlog, 2026-11-25", whose body lists the proposals with their reasons, and writes its status there with no design step. Everything after that already exists: the card, the questions, the answer, the Mac service picking up an unanswered card. When the answers have been acted on, the session closes the issue, which ends the record. Cost: one extra issue per press on GitHub, closed within a day or so, and the card shows the Implementation and Prep boxes, which mean nothing here. The board would hide them, and the "file an issue" choice, for an issue with a `backlog proposal` label.
- **(b) A card of its own on the board, with no issue.** Cleaner on GitHub and on the page, but the record, the status command, the watcher and the Mac service all name work by its issue or PR number, so each needs a second way to name a piece of work. Roughly twice the build.

## What the 4 counts

"Most sessions open at once" can mean two things:

- **(a) Sessions running on the Mac at once** (my pick). The Mac service's existing limit, raised from 2 to 4, shared by answer sessions, proposal sessions and pick-up sessions. Pick-ups past the limit wait their turn. This doesn't stop work piling up on Danyel's side, but he decides that each time he answers a proposal card.
- **(b) Pieces of work Claude has open.** The board stops offering to pick up more while 4 records are open. Closer to "how much am I juggling", but there are already more than 4 open records across the repos, so the button would be off most of the time unless only picked-up items count.

## Claude's calls, for Danyel to confirm

- Picked-up issues run through the Mac service as `claude -p` sessions, not as Remote Control sessions in claude.ai/code as the first design said. There is still no way for the service to start a Remote Control session, and everything else on the board already works this way.
- Up to 5 to pick up per card, and any number to close.
- "Later" keeps an issue off the next two weeks of proposals.
- Answers waiting go ahead of pick-ups for a free session.
- One button per repo, not one for all repos, since each session works in one repo's clone.

## Left for later

- A (per-issue Pick up button) and B (pick up the next N). Both would add pick-up rows directly.
- Proposals across all repos at once.
