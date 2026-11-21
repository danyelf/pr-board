# PR Board: three gates, and the board holds the workflow

Date: 2026-11-20. Status: draft for Danyel's review.

This replaces the parts of `2026-11-05-pr-board-design.md` that cover the stage strip, the status section, the turn labels, how answers travel and how they are claimed. Where the two disagree, this one wins. The older document's goals, its page sections (Waiting on you, On Claude, Quiet, Backlog) and its "Left for later" list still stand.

## Why

Two things went wrong with the first design.

**The lights didn't say where a PR was.** The strip had six boxes (Issue, Design, Build, Your look, Prep, Ready for merge) that mixed three kinds of thing: steps of the work, whose turn it was, and facts about GitHub. "Your look" was one box for every approval Danyel ever gave. torahmap#626 was prepped and mergeable, and its card still said "Needs your look" and asked the look question again. Danyel wants to glance down the page and see at once what is ready to merge, and where everything else is.

**GitHub was being used as a message queue.** GitHub is the right home for what it owns: the PR, its commits, its checks, whether it can merge. The first design also stored the workflow there. The ask was text inside the PR description that the board parsed. Whose turn it was lived in a label and again in that text, so the board needed a "label out of sync" state. Danyel's answers were specially formatted comments posted from his account. Sessions claimed them with a 👀 reaction, the Mac service with 🚀, and a failure was 😕. Each answer carried a fingerprint so it couldn't land on changed questions. Most of the bugs and odd states came from this. Danyel doesn't read any of it on GitHub; he reads the board, and on GitHub he scans the PR list and its labels.

## Goals

- One glance at a card says which gate the PR is in and whether it is Claude's or Danyel's. One glance down the page says what is ready to merge.
- The workflow has one record, in one place, so nothing can disagree with anything else.
- Only Danyel approves a gate, and only Danyel merges, on GitHub.
- The PR list on GitHub stays useful to scan: labels say the gate, whether it is waiting on Danyel, and whether it is ready to merge.

## Non-goals

- Keeping the old strip, the old status section, or the old answer comments readable. Nothing has to stay compatible.
- The timeline, the activity upload, "File an issue" and "Pick up". They stay on the later list.
- A way for Danyel to send a PR back a gate from the board. He writes a note; Claude decides whether the note means going back.
- Showing the status on the PR page on GitHub.
- Reading the comments Danyel leaves on GitHub. In the six weeks checked he did this about six times ("added a comment on 481"). The board doesn't see them; he tells Claude, or puts the note on the card.
- Work that isn't about one PR: questions to Claude, triage, investigations. About a third of his messages. It stays in chat.

## Anti-goals

- The board shows something as fine when it is waiting on Danyel. (Unchanged, and still the first rule.)
- A card shows "ready for merge" when GitHub would refuse the merge, or when the code changed after prep.
- Claude ends a turn having touched a PR without the board's record being right.
- The board is unreachable and Claude carries on silently. A status that couldn't be written must stop the turn and be said out loud.
- The tool spends tokens while nothing is happening.

## What lives where

| What | Where |
|---|---|
| The PR, commits, checks, conflicts, whether it can merge, whether it merged | GitHub, read fresh by the board |
| The gate, the state inside it, approvals, the ask, questions, how to test | The board's database (Cloudflare D1) |
| Danyel's answers and who picked each one up | The board's database |
| A log of every change to a record | The board's database |
| Labels on GitHub | A copy the board writes. Nothing reads them back. |
| Running Mac sessions | The process list, as now |

## The model

### Three gates

**Design → Implementation → Prep for merge**, in that order. A piece of work is in exactly one gate.

Inside a gate, Claude writes one of four states:

| State | Meaning | Whose turn | Colour |
|---|---|---|---|
| working | Claude is on it | Claude | blue |
| paused | Claude stopped to ask questions and can't go on without the answers | Danyel | blue, with an amber "N questions" badge |
| complete, at Design or Implementation | Claude has finished the gate's work | Danyel | amber |
| complete, at Prep | prep has run | Danyel | green when it can merge, red when it can't (see Prep below) |
| parked | waiting on something outside both of them | nobody | grey |

What "complete" asks of Danyel depends on the gate:

| Gate complete | Danyel's choices |
|---|---|
| Design | **approve, build it** · needs changes |
| Implementation | **looks good, prep for merge** · needs changes |
| Prep for merge | no approval. A link to merge on GitHub, and "needs changes" for a last-minute problem |

- **Approve** records the approval, with its time, against the gate. The gate shows ✓ approved from that moment. Only an answer from Danyel on the board can record an approval.
- **Needs changes** must come with a note. The gate stays where it is and the note goes to Claude.
- **An approval can carry a note,** meaning "yes, and also do this" ("430: fix the check. Then prep the pr."). The gate is approved; Claude does what the note says as part of the next gate's work.
- **Every card has a note box all the time,** also while Claude is working. A note sent with no choices is delivered to Claude exactly as an answer is. It doesn't change the gate or the state by itself. Danyel gives feedback mid-work on nearly every large PR, so this is an everyday move, not an exception.
- Claude reads the note whatever the choices say.
- Claude's own questions keep the rules Danyel set: numbered, each with choices, one default in bold, and a "file an issue" choice that means "take the default and file the question for later". The approval question has no "file an issue" choice (Claude's call: an approval can't be deferred).
- A complete gate may carry questions too. Danyel answers them and the approval together.

### Prep for merge, and what "ready" means

When Claude marks Prep complete, the status command records the PR's head commit. The board then draws the gate from GitHub's facts, not from Claude's word:

- **Ready for merge** (green): the head commit is still the one prep finished on, and GitHub says the PR can merge. GitHub's "blocked" counts as mergeable when the only thing missing is a required approving review and the checks have passed, because Danyel supplies that review when he merges.
- **Can't merge yet: reason** (red): anything else. The reasons are the ones the board already knows: commits since prep, conflicts, checks failing or still running, behind main, draft, stacked on an open PR, GitHub still checking.

Both sit in "Waiting on you". A red card has the note box, so Danyel can send it back with one line.

To judge this the Worker reads, for each PR, GitHub's merge status, its review decision, and the combined result of the head commit's checks. "Blocked" with "review required" and checks that passed (or no checks at all) is mergeable. Every other "blocked" is red, as "GitHub is blocking the merge". GitHub doesn't say which rule is blocking, so one case can't be told apart: a repo that requires a review and also has a second rule that is unmet would show green. None of Danyel's repos has such a rule today. If one gains one, this needs revisiting.

Prep needs a PR: the command refuses `--gate prep` on an issue.

### Going forward, going back, and rounds

- **Forward** needs the earlier gate approved. The status command refuses to move a record to Implementation while Design is unapproved, or to Prep while Implementation is unapproved.
- **Design is optional, and chosen at the start.** When Claude writes the first status for a piece of work it says whether there is a design step. With none, the card has two gates, Implementation and Prep for merge, and no third box. Danyel often judges a design from the built thing, so for much work a separate design step does nothing. A piece of work that turns out to need one can gain it later: that is a move back, with a reason, like any other. Nothing may start at Prep.
- **Back** is Claude's move, and deliberate: moving a record to an earlier gate needs a reason, which the card shows. The approvals of that gate and every later one are cleared. Later gates that had been started show dimmed as "on hold".
- **Rounds.** Each time a gate is handed to Danyel as complete counts as a round, whether it came back after "needs changes" or after being reopened from a later gate. From the second on, the gate says "round 2", and so on.
- **Answers are kept.** Going back clears the approvals on the record, but the answer rows that gave them stay, as history.

### The record

One record per piece of work. A piece of work is not the same thing as a PR: it may begin as an issue, gain a PR, and have that PR thrown away and replaced. The record names the issue, if there is one, and the PR that currently carries the work, if there is one. It holds whether there is a design step, the gate, the state, the ask, the questions, how to test, when the turn last changed, each gate's approval (or that it was skipped), the round count per gate, the reason for the last move back, the head commit prep finished on, and a version number.

**The version goes up on `pr-status set` and on nothing else.** A claim changes the state and the ask (see "How answers travel") but leaves the version alone. That one rule carries three others: an answer is to one version, and a version takes one answer; "picked up, but nothing since" means the version hasn't moved since the claim; and the end-of-turn hook is satisfied only by a version that went up, so claiming an answer and then doing nothing doesn't pass it.

Work can start on an issue. When its PR opens, the first status written for the PR attaches the PR to the same record: it keeps its approvals, its log and its answers. The link is the PR's `Closes #N` or `Refs #N`, as today. Asking the board about either number gives the same record, so a watcher started on the issue still gets its answers.

**Replacing a PR.** Claude can attach a new PR to a record in place of the old one (`--replaces <old PR>`). The record keeps its approvals unless Claude also moves it back a gate. This covers a PR that is scrapped and rebuilt, and one that is split, where the remainder gets a record of its own.

**Trying something in a live PR.** Live code is often easier to try than a preview or a mockup, so Claude may open a PR just to try an idea in, and then throw it away and start again. The board has no special marking for this (Danyel's call: nothing mechanical until it proves needed). Claude says in the ask that the PR is for trying, and when it is thrown away the next PR replaces it on the same record, as above.

**When a record ends.** When its PR merges, from any gate. Danyel sometimes merges before prep, and the board doesn't complain; the log says which gate it was in. When its PR closes unmerged and nothing replaces it, or its issue closes with no PR, the record ends too. The board keeps ended records, and their logs, for the history.

Every change to a record adds a line to a log table: when, who (Claude's status command, Danyel's answer, a claim, the Mac service, the one-off pass at the switch), and what changed. It is for working out what happened to one item, and later for the timeline. The board never reads it to decide what to show.

## How Claude talks to the board

The status command stays one command, with the same name, and now writes to the board:

```
pr-status set <owner/repo#N | #N> \
  --gate design|implementation|prep \
  --state working|paused|complete|parked \
  --ask "one line" \
  --question "Colour of the button? (**red** | green)" \
  --to-test "what to open, what to try, what should happen" \
  --reason "why this goes back to an earlier gate" \
  --no-design            (first status only: this work has no design step) \
  --replaces <old PR>    (this PR takes over the old one's record)
```

- `--gate` and `--state` are required. They replace `--waiting`: whose turn it is follows from the state, so the two can't disagree.
- It refuses: paused with no question; a question with no bold default; complete at Implementation with no `--to-test`; parked with no `--ask` saying what it waits on; forward past an unapproved gate; back without `--reason`; anything with a line break in it.
- Handing a PR to Danyel (paused or complete) still asks for his review on GitHub the first time, and again when it comes back to him after more work, so GitHub notifies him.
- `pr-status ok <ref>` still says "I touched this, and the status is still right". It now records that on the board (a time on the record and a line in the log), not in a file on the Mac. On an item with no record it fails and says to run `set`. `show` prints the record.

The board gets a small HTTP interface for this, under its own path, on the same Worker and behind the same Access application as the page. Claude's side signs in with a Cloudflare Access service token (a client id and secret that Access checks), kept in a file on the Mac that only Danyel's user can read. The application gets a second policy, of the "Service Auth" kind, that admits that token. Service tokens expire (a year by default, or never if set so when created); when one has expired the command fails with its ⚠️ message, and the README says how to make a new one. The Worker tells the two callers apart from what Access vouches for: Danyel's Google sign-in may answer and approve; the service token may write statuses, read and claim answers. Neither may do the other's part.

If the board can't be reached, or refuses, the command fails with a message beginning ⚠️ and Claude tells Danyel. It never falls back to writing somewhere else.

### The end-of-turn hook

Unchanged in purpose: when a turn pushed to a PR's branch, commented on a PR or issue, or opened one, the hook checks that the item's record was written (its version went up) or confirmed with `ok` during the turn, and blocks the stop if not. It now asks the board instead of GitHub. If it can't reach the board it blocks once with a ⚠️ message saying so, and doesn't pass silently.

## How answers travel

1. Danyel picks choices on a card and presses **Send answers**. The Worker writes one answer row: the item, the version of the status it answers, the choice for each question, the approval choice if the gate was complete, the note, and the time. It refuses if the record's version is no longer the one the page was drawn from, if the item is closed, or if that version already has an answer. An approval is recorded in the same step.
2. The card moves to "On Claude" as "answered, waiting for Claude to pick it up". If the answer approved a gate, that gate shows ✓ and the next one shows the same waiting line.
3. **The session working on the item picks it up.** A session keeps one background watcher running for all the items it has written a status for, whatever their state, not only after handing one over. When it writes a status for an item the watcher doesn't cover, it replaces the watcher with one covering all of them, and after the watcher wakes it with an answer it starts it again. This matters most while Claude is working: the Mac service leaves working records alone (step 4), so a note sent then waits for that session's watcher. The watcher asks the board about once a minute for answers to those items. When it finds one it claims it, prints it and exits, which wakes the session. The claim is one database update that succeeds only if nobody has claimed the answer, and in the same step sets the record to working with the ask "Working on your answers". The watcher still never exits on a timer or an error, and still costs no tokens while it waits. Anything holding the service token is allowed to claim; what keeps sessions out of each other's way is that a watcher asks only about the items its own session wrote a status for, and that a claim can succeed once. The claim records who made it (the session, or the Mac service).
4. **If no session claims it within 5 minutes of the answer being sent**, the Mac service claims it the same way, marked as its own, starts a fresh `claude -p` session in the item's worktree with the answers in the prompt, and sets the ask to "A Mac session is working on your answers". It leaves alone every record in the working state, whether a claim set it or a session wrote it, so it never starts a second session beside one that is working. A note to a working record whose session has stopped therefore waits, and after 10 minutes shows as "Answered, not picked up".
5. **If that session ends without writing a new status**, the service marks the answer "gave up" and sets the record back to Danyel in the same gate, with where the session's output is. The card says "A session tried and gave up" and offers the form again. There is no automatic retry.

The states Danyel sees are the ones already agreed, now read from the answer row instead of from reactions:

| Answer row | Board |
|---|---|
| unclaimed, under 10 min | On Claude: answered, waiting for Claude to pick it up |
| unclaimed, 10 min on | top: Answered, not picked up |
| claimed by a session | On Claude: Claude is working on your answers |
| claimed by a session, and no new status an hour on | top: Picked up, but nothing since |
| claimed by the Mac service | On Claude: Mac session working on it (the service stops a session at its time limit, an hour by default, and that becomes "gave up") |
| gave up | top: A session tried and gave up |

What Claude does with an answer:

- **approve, build it**: start Implementation (`--gate implementation --state working`).
- **looks good, prep for merge**: run the prep-for-merge skill, which starts with `--gate prep --state working` and ends with `--state complete`, or `--state paused` with questions when a decision is Danyel's.
- **needs changes**: read the note. Stay in the gate, or go back with `--reason` when the note shows an earlier gate was wrong.
- A question's own choice, and "file an issue": as today.

## The Mac service

Same job, simpler inside. It asks the board for unclaimed answers older than its grace period, instead of reading every labelled item on GitHub. Everything it used to record with reactions is a column on the answer row. It still finds its own sessions in the process list by the name it starts them with, still has no state file, still does everything that can fail before it claims, still acts as Claude's account in the sessions it starts, and still logs every line about an item with that item first. Its worktree rules, time limit, limit of two sessions, dry run and stopping rules are unchanged.

## The page

The sections stay: Waiting on you (oldest wait first), On Claude, Quiet, Backlog. A card keeps its links, its questions with the default standing out, how to test, the note box, Send answers, and its files. The six-box strip is replaced by the three gates.

```
#626 Tools state                                   Ready to merge · 3 h
┌─────────────┬──────────────────┬──────────────────────────┐
│ DESIGN      │ IMPLEMENTATION   │ PREP FOR MERGE           │
│ ✓ approved  │ ✓ approved       │ ● ready for merge        │   green
└─────────────┴──────────────────┴──────────────────────────┘
  Merge on GitHub →                       needs changes: [ note ]

#573 Pinned verses                              1 question for you · 2 h
┌─────────────┬──────────────────────────┬──────────────────┐
│ DESIGN      │ IMPLEMENTATION           │ PREP FOR MERGE   │
│ ✓ approved  │ Claude paused            │ ·                │   blue, amber badge
│             │ (1 question)             │                  │
└─────────────┴──────────────────────────┴──────────────────┘

#580 Search box                         Design ready for your approval · 1 d
┌──────────────────────────┬──────────────────┬──────────────────┐
│ DESIGN                   │ IMPLEMENTATION   │ PREP FOR MERGE   │
│ complete: your approval  │ ·                │ ·                │   amber
│ round 2                  │                  │                  │
└──────────────────────────┴──────────────────┴──────────────────┘
  [ approve, build it ]  [ needs changes ]   note: ________

#564 Layout                                         Claude designing
┌──────────────────────────┬──────────────────┬──────────────────┐
│ DESIGN                   │ IMPLEMENTATION   │ PREP FOR MERGE   │
│ Claude working, round 2  │ on hold          │ ·                │   blue; dimmed
│ reopened: "the grid      │                  │                  │
│ can't hold long titles"  │                  │                  │
└──────────────────────────┴──────────────────┴──────────────────┘
```

The short tag in a card's header:

| Situation | Tag |
|---|---|
| paused | N question(s) for you |
| Design complete | Design ready for your approval |
| Implementation complete | Ready for your look |
| Prep complete and mergeable | Ready to merge |
| Prep complete, not mergeable | Can't merge yet: reason |
| working | Claude designing / building / prepping |
| parked | Parked |
| answer states | as in the table above |

### Two views

A switch at the top of the page chooses between two views of the same cards. The choice is kept in the address, so a bookmark or a reload keeps it.

- **By whose turn** (the sections above). Cards move between sections as their state changes. Good for "what is waiting on me".
- **Everything, in a steady order.** One list of every open item that has a record, plus open PRs with none. The order is when the work started, newest first, and never depends on the state, so nothing jumps when Danyel sends an answer: the card stays where it is and its gates change colour. Each row's gates are the light that says whose turn it is. The Backlog stays a separate list below. (Claude's calls: what the list holds and its order. This takes in issue #19.)

### A live page

The first board was plain HTML with no script, under a policy that forbade nearly everything. Every answer reloaded the whole page, and nothing updated by itself. That was safe and annoying. The new page is a small program running in the browser:

- **Sending answers doesn't reload the page.** The card shows it is sending, then shows its new state in place. A refusal (the status changed since the page was drawn, for example) appears on the card, with the fresh questions.
- **The page keeps itself current.** About every 30 seconds it asks the board for the current state and updates cards and rows in place. It never touches a card Danyel is in the middle of answering (a choice changed or a note typed and not yet sent); that card gets a small "this changed, reload it" line. It stops asking while the tab is hidden. (This takes in issue #20.)
- **Ctrl+Enter or Cmd+Enter in a card sends its answers.** (Issue #17.)

The security that replaces "no script at all":

- **Only the board's own script runs.** The script is a file served by the Worker. The page's policy allows scripts and requests from the board's own address and nowhere else, with no inline script and nothing from other sites. Images still load over https, for screenshots.
- **Text from outside is always shown as text.** PR titles, asks, questions, notes and anything else that came from GitHub or from Claude are put on the page as text, never as HTML, so nothing in a title or a note can run.
- **Every request that changes something** must come from the board's own address, be signed in through Access, and carry a JSON body, which a form on another site can't send. The Worker checks all three.
- **Danyel's sign-in and Claude's service token stay separate**, as above: the page's script can answer and approve, and can't write a status.

The page still works without the Mac, and a failed refresh shows a small "couldn't refresh" line with the time of the last good one, not a stale page that looks current.

**An open PR with no record** still appears, in "Waiting on you", tagged "No status written". The board keeps listing the open PRs of every repo it covers, so a PR that Claude opened and forgot can't hide. Open issues with no record are the Backlog, as now.

## Labels on GitHub

The board keeps these labels on each item with a record, as a copy:

- one of `gate: design`, `gate: implementation`, `gate: prep`
- `on <owner>` while it is Danyel's turn
- `ready to merge` while the card is green
- `parked` while parked

`in-progress` stays as it is, set by whoever picks the item up; the board doesn't manage it.

The Worker sets the labels when a record changes. `ready to merge` also depends on GitHub (checks finishing), which no record change announces, so every time the board fetches an item from GitHub it compares the labels with what they should be and corrects them. A wrong label therefore fixes itself within a page load or two, and is never shown as a problem.

The board reads its own database fresh on every page load, so an answer Danyel just sent shows at once. What it fetched from GitHub may be up to a minute old, as now, and labels are corrected only on a fresh fetch, so a page load never writes to GitHub more than once a minute per item.

## The Worker's GitHub token

The Worker no longer posts anything as Danyel. It reads, and it sets labels. So it runs on Claude's account's token (danyel-claude) instead of Danyel's own (Danyel agreed, 2026-11-20). Danyel's token then isn't stored in the Worker at all. The cost: danyel-claude sees only the repos it is a collaborator on, so the board covers those, which are the repos Claude works in. Checked on 2026-11-20: it has write access, which setting labels needs, to `danyelf/torahmap`, `danyelf/pr-board`, `danyelf/danyelfisher.info` and `danyelf/ieeevis-scrape`.

The board lists a repo when the token can see it and it was pushed to in the last 60 days, as now, or when it has an open record, so work in a quiet repo doesn't drop off the page.

## What goes away

- The status section in PR descriptions and the status comment on issues, with its hidden data line and the "status edited by hand" tag.
- Turn labels as the record of whose turn it is, and "label out of sync".
- Answer comments, the 👀 🚀 😕 reactions, and the fingerprint.
- The `🤖 Claude: prep for merge` comment as a signal, and the "reviewed" note read from review comments. The prep skill may keep posting its review on the PR for Danyel to read; the board doesn't read it.
- The Issue box. The linked issue stays as a link on the card.
- PR #22 is closed unmerged; issues #17, #19, #20 and #21 are closed by this work.

## Moving over

- Built on a branch and switched over once. There is no period where some of the state is in the database and some on GitHub.
- A one-off pass at the switch: Claude reads each open PR and labelled issue and proposes its gate, state, approvals and ask. Danyel approves the list before anything is written. This pass is the only thing allowed to record approvals without a board answer.
- The same pass removes the old status sections from open PR descriptions and deletes the old status comments on open issues.
- The `pr-status` and `prep-for-merge` skills are rewritten for the new command. The skills Claude uses to brainstorm and design say to write `--gate design`.
- Danyel's part: create the Access service token and its policy in the Cloudflare dashboard, create the D1 database (or approve Claude doing it with wrangler), and change the Worker's GitHub token if he agrees to the change above.

## Approaches considered

1. **Move the whole workflow into the board's database at once (chosen by Danyel).** Biggest rewrite, since the status command, the watcher, the hook, the Mac service and the page all change. Each part gets simpler and nothing is left half in the old scheme.
2. **Move the status first and leave answers on GitHub.** Gates on the board sooner, but the answer comments and reactions, which caused the most trouble, would stay, and the state would be split between two places for a while.
3. **Keep GitHub as the store and add the gate to the status section.** Smallest change. It adds weight to the part being replaced. Ruled out.

A fourth idea, having the board work the gate out from clues on GitHub so that Claude writes nothing new, was dropped earlier: Danyel's workflow opens the PR during design, so nothing on GitHub tells Design from Implementation.

## Decided by Danyel

- Three gates: Design, Implementation, Prep for merge. Each is Claude working or complete; Design and Implementation are then approved by him; Prep ends at ready for merge.
- Design is optional, chosen per piece of work.
- A PR may be spun up to try something live and then thrown away, with no special marking on the board until one proves needed.
- The lights show where in the flow a PR is. Progress is forward by default; going back is allowed and deliberate.
- Only he merges, on GitHub. The board has no merge button and Claude has no permission to merge.
- Claude writes the gate down; the board doesn't guess it.
- The workflow moves off GitHub into the board's database, all at once.
- Labels on GitHub show the gate, `on danyel` and `ready to merge`.
- His way to push back is a note. No "back a gate" button for now.
- Nothing has to stay compatible with what exists.
- The board covers only the repos danyel-claude can reach, and runs on its token.
- A switch to a view of everything, so that cards don't jump when he answers.
- A live page with real security, not a script-free one.

## Claude's calls, for Danyel to confirm

- What the "everything" view holds and its order (when the work started, newest first).
- How the live page behaves: answers sent in place, a refresh every 30 seconds that leaves a card he is answering alone, Ctrl+Enter to send.
- The page's security rules: only the board's own script, outside text shown as text, and the three checks on every change.

- The four states, and "paused" as a blue gate with an amber badge.
- `--state` replaces `--waiting`.
- The approval question has no "file an issue" choice; "needs changes" needs a note.
- "Ready for merge" is drawn from GitHub's facts plus the commit prep finished on.
- A blocked prep sits in "Waiting on you" in red.
- The status command refuses to go forward past an unapproved gate; nothing starts at Prep.
- A log table of every change.
- Claude signs in with a Cloudflare Access service token.
- The Worker writes the labels and corrects them whenever it reads.
- An open PR with no record shows as "No status written" in "Waiting on you".
- An approval can carry a note; every card has a note box all the time.
- A PR can be replaced and keep its record; a merge or close from any gate ends the record without complaint.
## Checked against the past

On 2026-11-20 an agent read about 2,000 of Danyel's typed messages from 9 October to 20 November and followed about 20 torahmap and pr-board PRs. The skeleton held: "prep N for merge" (about 25 times) is the Implementation approval, choosing among options is the Design approval, and Claude's numbered questions are the paused state. Three cases showed the gates catching real mistakes: a PR built past a design he "never okayed" (429), five merges of PRs whose build wasn't finished, and an approval the old board forgot (626). The misfits it found are why this document has an approval that carries a note, a note box on every card, optional design, replaceable PRs, and a record that ends quietly on any merge or close. The sample was excerpts from 11 sessions, nearly all one repo, and the counts are rough.

## Left to the builder

- The database tables and the shape of the HTTP interface.
- How the Worker tells Danyel's sign-in from the service token in what Access sends.
- How the claim is made a single safe step in D1.
- How the watcher and the Mac service pace their requests and back off.
- The exact look of the gates, the badge, "on hold" and the phone layout, within the colours above.
- The order the parts are built in on the branch.
