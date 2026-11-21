---
name: pr-status
description: Use when handing a PR or issue back to Danyel, asking him a question about one, or starting work on one.
---

# Keeping a piece of work's status on PR Board

Danyel's PR Board keeps one record for each piece of work: which gate it is in, what state it is in there, what you need from him, your questions and how to test the change. The record lives in the board's own database, not on GitHub. You write it with one command:

`node /Users/danyel/code/MISC/pr-board/cli/pr-status.ts`

There is no `pr-status` program on the path. In the examples below, `pr-status` is short for that whole command, so type the full `node …` line.

## Gates and states

Work moves through three gates, in order: **design**, **implementation**, **prep** (prep for merge). It is in exactly one gate at a time. Inside the gate you say which of four states it is in:

| State | Means | Whose turn |
|---|---|---|
| `working` | You are on it. | yours |
| `paused` | You stopped to ask questions and can't go on without the answers. Needs at least one `--question`. | Danyel's |
| `complete` | You have finished the gate's work. At design and implementation this asks Danyel to approve; at prep it means prep has run. | Danyel's |
| `parked` | It waits on something outside you both. Needs an `--ask` saying what it waits on. | nobody's |

What Danyel can answer to a complete gate:

- Design complete: **approve, build it** or needs changes.
- Implementation complete: **looks good, prep for merge** or needs changes.
- Prep complete: no approval. He merges on GitHub, or sends a note as "needs changes" for a last-minute problem.

Only Danyel approves a gate, and only from the board. You never write an approval.

## Writing a status

```
pr-status set <owner/repo#N | #N> \
  --gate design|implementation|prep \
  --state working|paused|complete|parked \
  --ask "what you need from him, in one line" \
  --question "Colour of the button? (**red** | green)" \
  --to-test "what to open, what to try, what should happen"
```

Other flags, used only when they apply:

- `--no-design`: on the first status of a piece of work that has no design step. Its card then has only implementation and prep.
- `--reason "…"`: why the work goes back to an earlier gate. Required for any move back.
- `--replaces <old PR number>`: this PR takes over the record of a PR you threw away or split. The record keeps its approvals unless you also move it back a gate.
- `--issue <N>`: the issue this work belongs to, when the PR's description doesn't say `Closes #N` or `Refs #N`. Normally the command finds it there, so the PR joins the record that began on the issue. GitHub reads `Closes #N` only on a PR into the default branch, so a PR built on another PR's branch needs `Refs #N` or `--issue`.

The rules the command enforces:

- `--gate` and `--state` are always required.
- **Forward needs the earlier gate approved.** You can't move to implementation while design is unapproved, or to prep while implementation is unapproved. Nothing starts at prep, and prep needs a PR, not an issue.
- **Back needs `--reason`.** Going back clears the approvals of that gate and every later one. The card shows the reason.
- Every `--question` has choices with exactly one in bold as the default, like `(**leave** | change)`. Questions are replaced each time: repeat `--question` for every question still open. The board adds a "file an issue" choice to each of your questions itself; don't write it in.
- `--to-test` is required at implementation complete. Put the steps there: what to open, what to try, what should happen.
- Each of `--ask`, `--to-test`, `--question` and `--reason` is one line. Write several steps as `1) … 2) … 3) …` on one line.
- When a PR's status hands it to Danyel (paused or complete), the command also asks him to review it on GitHub, so GitHub notifies him.

## When to write each status

- **Starting to brainstorm or design** a piece of work: `--gate design --state working`. Do this when the design work begins, before the PR exists if need be (write it on the issue). The brainstorming skill doesn't say this, so this rule is the one to follow.
- **Starting work with no design step** (a small fix, or a change Danyel will judge from the built thing): the first status is `--gate implementation --state working --no-design`.
- **Design ready for him**: `--gate design --state complete`, with an `--ask` saying what to look at.
- **After "approve, build it"**: `--gate implementation --state working`.
- **Built and ready for his look**: `--gate implementation --state complete --to-test "…"`.
- **After "looks good, prep for merge"**: run prep for merge (the `prep-for-merge` skill). It starts with `--gate prep --state working`, and ends with `--state complete` (the board then checks for itself whether GitHub would let the PR merge, and shows it green or red), or with `--state paused` and questions when a decision is Danyel's.
- **You need a decision to go on**: `--state paused` with the questions, in whatever gate you are in.
- **Stuck on something outside you both**: `--state parked --ask "what it waits on"`.
- **A new PR in place of an old one**: the first status on the new PR carries `--replaces <old PR>`.
- **You find an earlier gate was wrong** (for example, building shows the design can't work): go back with `--reason`.

When you touched an item but its status is still right, say so instead of writing it again:

```
pr-status ok <owner/repo#N>
```

`show <ref>` prints the record as JSON. (`import` exists only for moving the old statuses over to the board; don't use it.)

## The end-of-turn hook

A Stop hook checks every PR or issue you pushed to, commented on or opened during a turn. If its record wasn't written with `set` or confirmed with `ok` during that turn, the hook stops the turn and tells you which items to update. A claim of answers doesn't count; only a new status does.

## When the board can't be reached

Every failure to reach the board, or to be accepted by it, prints a line starting with ⚠️ and the command fails. That means the board or its service token (the file `~/.config/pr-board/access-token.json`) is broken. Tell Danyel exactly what the ⚠️ line says. Don't retry in a loop, and never fall back to writing the status on GitHub, in a PR description or in a comment: nothing reads it there.

## Answers from the board

Danyel answers on the board. An answer can hold a choice for each of your questions, an approval when a gate was complete, and a note. **A note can come at any time**, also while you are working, with no choices at all: it is feedback mid-work, and it reaches you the same way an answer does. An approval can carry a note too, meaning "yes, and also do this".

**Keep one watcher running** in the background for all the items you have written a status for in this session, with the Bash tool's background option:

```
node /Users/danyel/code/MISC/pr-board/cli/watch-answers.ts <owner/repo#N> [<owner/repo#M> ...]
```

It costs nothing while it waits. The rules:

- Start it after your first `set` in the session.
- When you write a status for an item the running watcher doesn't cover, stop that watcher and start one that covers all your items. Never run two.
- When it exits, it has claimed an answer (which sets the record to working, with the ask "Working on your answers") and printed it. Start it again for all your items straight away, then deal with what it printed, so a note Danyel sends meanwhile still reaches you.

The watcher matters most while you are working. The Mac service leaves an item in the working state alone, so a note Danyel sends while you work waits for your watcher; with none running, it sits there and shows as "Answered, not picked up" after 10 minutes.

Act on each answer:

| The answer says | What you do |
|---|---|
| **approve, build it** | Design is approved. Start implementation: `--gate implementation --state working`. |
| **looks good, prep for merge** | Implementation is approved. Run prep for merge (the `prep-for-merge` skill). |
| **needs changes** | Read the note. Stay in the gate and make the changes, or go back a gate with `--reason` when the note shows an earlier gate was wrong. |
| an approval with a note | The gate is approved. Do what the note asks as part of the next gate's work. |
| a choice on one of your questions | Do that. |
| **file an issue** on a question | Take the default, then file a new issue holding the question, its choices, any screenshots and a link back to the PR. Say in the next status that the default was taken and the question moved to the new issue. Don't start work on the new issue. |
| a note with no choices | Read it and act on it. It doesn't change the gate or the state by itself. |

Read the note whatever the choices say; it can change what they mean.

When you are done, write a new status with what is left.

What Danyel sees on the board while an answer waits: "answered, waiting for Claude to pick it up" for its first 10 minutes; then "Answered, not picked up" at the top of his page. Once claimed, "Claude is working on your answers"; if an hour passes after the pickup with no new status, "Picked up, but nothing since". So write the new status as soon as you have acted.

**A session can also start with the answers in its first message.** When an item is not in the working state and no session claims its answer within 5 minutes, the PR Board service on the Mac claims it, starts a fresh session (`claude -p`) in the item's worktree with the answers in the prompt, printed the way the watcher prints them, and sets the ask to "A Mac session is working on your answers". That session has no chat memory: read the PR or issue and its record (`show`) first, check the branch is up to date (the worktree may be new, so install dependencies before running tests), then act on the answers as above. Don't start the watcher in such a session; it ends when you finish, and the service starts a new one for the next answers. End with `--state paused`, `complete` or `parked`, even to say you couldn't act; never end on `working`, since nobody is left to carry on. If the session ends without writing a new status, the service marks the answer as given up and hands the item back to Danyel as "A Mac session gave up on your answers".
