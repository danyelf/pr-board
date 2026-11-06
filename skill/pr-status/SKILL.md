---
name: pr-status
description: Use when handing a PR or issue back to Danyel, asking him a question about one, or starting work on one.
---

# Keeping a PR's status current

Danyel's PR Board reads a status section at the top of each PR description (or, for an issue with no PR yet, in one comment). You keep it current with one command. The absolute path is:

`node /Users/danyel/code/MISC/pr-board/cli/pr-status.ts`

## When to run it

Run `set` whenever the turn changes (you hand it to Danyel, he hands it back, or it is stuck on something outside you both) and whenever the ask changes.

```
node /Users/danyel/code/MISC/pr-board/cli/pr-status.ts set <owner/repo#N | #N> \
  --waiting danyel|claude|nobody \
  --ask "what you need from him, in one line" \
  --question "Colour of the button? (**red** | green)" \
  --to-test "what to click on the preview, and what you should see"
```

- `--waiting danyel` puts the `on danyel` label on; `nobody` marks it `parked`; `claude` clears both.
- Every `--question` needs choices with exactly one in bold as the default, like `(**leave** | change)`. The command refuses a question without one.
- Put the test protocol (what to open, what to try, what should happen) in `--to-test`.
- Questions are replaced each time: repeat `--question` for every question that is still open.

When a turn changed nothing about the ask (you touched the PR but the status is still right), say so instead:

```
node /Users/danyel/code/MISC/pr-board/cli/pr-status.ts ok <owner/repo#N>
```

`show <ref>` prints the current status as JSON. A Stop hook blocks the end of a turn when you changed a PR or issue and did neither.
