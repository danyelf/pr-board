# PR Board

A dashboard of Danyel's PRs and the decisions waiting on him. Design: `docs/superpowers/specs/2026-11-05-pr-board-design.md`. Plans: `docs/superpowers/plans/`.

## Running commands without permission prompts

Danyel works in auto mode with an allowlist of simple commands (`git …`, `pnpm …`, `gh …`, `sed`, `cat`, …). Compound commands don't match it and stop to ask him, so:

- Never start a command with `cd <dir> && …` or `cd <dir>; …`. Name the directory instead: `git -C /abs/path …`, `pnpm -C /abs/path test`, absolute file paths. If a subshell is unavoidable, `(cd /abs/path && pnpm test)`.
- Edit files with the Edit/Write tools, not `sed -i`, heredocs, or inline `python3 - <<EOF` scripts (Danyel's rules forbid Python heredocs anyway).
- Append to a report with the Edit tool, not `cat >> file <<EOF`.
- One simple command per call beats a long `&&` chain.
- Keep every command on one line. A commit message with line breaks inside `-m "…"` prompts; put the attribution lines in `--trailer` flags instead: `git -c user.name=danyel-claude -c user.email=336262603+danyel-claude@users.noreply.github.com -C /abs/path commit -m "Subject" --trailer "Co-Authored-By: <the current model's name> <noreply@anthropic.com>" --trailer "Claude-Session: <session url>"`.

## Conventions

- pnpm, Node 24 (TypeScript runs directly). `pnpm test`, `pnpm typecheck`.
- Claude's commits are made as danyel-claude, both author and committer (the `-c` settings above), never with Danyel's name or email.
- No ticket or stage references in code comments.
