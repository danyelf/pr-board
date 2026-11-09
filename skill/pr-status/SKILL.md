---
name: pr-status
description: Use when handing a PR or issue back to Danyel, asking him a question about one, or starting work on one.
---

# Keeping a PR's status current

Danyel's PR Board reads a status section at the top of each PR description (or, for an issue with no PR yet, in one comment). You keep it current with one command:

`node /Users/danyel/code/MISC/pr-board/cli/pr-status.ts`

There is no `pr-status` program on the path. In the examples below, `pr-status` is short for that whole command, so type the full `node …` line.

## When to run it

Run `set` whenever the turn changes (you hand it to Danyel, he hands it back, or it is stuck on something outside you both) and whenever the ask changes.

```
pr-status set <owner/repo#N | #N> \
  --waiting owner|claude|nobody \
  --ask "what you need from him, in one line" \
  --question "Colour of the button? (**red** | green)" \
  --to-test "what to click on the preview, and what you should see"
```

- `--waiting owner` hands it to Danyel and puts his `on <name>` label on; `nobody` marks it `parked`; `claude` clears both.
- When a PR's turn moves to him, the command also asks him to review it, so GitHub notifies him. It doesn't ask again while the PR stays with him; it asks again when the PR comes back to him after more work.
- Every `--question` needs choices with exactly one in bold as the default, like `(**leave** | change)`. The command refuses a question without one.
- Put the test protocol (what to open, what to try, what should happen) in `--to-test`.
- Each of `--ask`, `--to-test` and `--question` is one line. The command refuses line breaks, so write several steps as `1) … 2) … 3) …` on one line.
- Questions are replaced each time: repeat `--question` for every question that is still open.

When a turn changed nothing about the ask (you touched the PR but the status is still right), say so instead:

```
pr-status ok <owner/repo#N>
```

`show <ref>` prints the current status as JSON. A Stop hook blocks the end of a turn when you changed a PR or issue and did neither.

## Answers from the board

Danyel answers on the board: one choice per question, a "How does it look?" answer on every PR waiting for his look (looks good, prep for merge | needs changes | file an issue), and a free-text note. The board posts them as one comment from his account. Don't add your own "how does it look" question; the board asks it.

**After every `set --waiting owner`**, start the watcher in the background for the items you just handed over (all of them, in one command), with the Bash tool's background option:

```
node /Users/danyel/code/MISC/pr-board/cli/watch-answers.ts <owner/repo#N> [<owner/repo#M> ...]
```

It costs nothing while it waits. Don't stop it, and don't start a second one for the same items. When answers come it claims each one with a 👀 reaction (that is how the board knows a session has them), prints them, and exits, which wakes you. Then, for each answer:

- If it says the fingerprint does **not** match the current status, the questions changed after he answered. Don't apply anything; ask the current questions again with `set --waiting owner`.
- **looks good, prep for merge**: run prep for merge (the `prep-for-merge` skill).
- **needs changes**: make the changes the note asks for; the PR stays before prep.
- A question's own choice: do that.
- **file an issue** (on a question, or on the look): take the default, then file a new issue holding the question, its choices, any screenshots and a link back to the PR. Mark the question on the PR "default taken; moved to #NNN". Don't start work on the new issue.
- The note: read it whatever the choices say; it can change what they mean.

Then run `set` again with the new state (`--waiting claude` while you work, `--waiting owner` with what is left when you hand it back) and start the watcher again for whatever you handed back.

**A session can also start with the answers in its first message.** When no open session picks an answer up within 5 minutes, the PR Board service on the Mac claims it and starts a fresh session (`claude -p`) in the item's worktree, with the answers in the prompt, printed the way the watcher prints them. That session has no chat memory: read the PR or issue and its status (`show`) first, check the branch is up to date (the worktree may be new, so install dependencies before running tests), then act on the answers as above and end with `set`. Don't start the watcher in such a session; it ends when you finish, and the service starts a new one for the next answers. If the session ends without a new `set`, the service takes its 👀 back so the board shows the answer as not picked up; always end with `set`, even to say you couldn't act.
