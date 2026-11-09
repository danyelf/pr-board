# PR Board

PR Board is a single web page that lists the pull requests (PRs) and issues Danyel has in flight across his GitHub repos, and says whose turn each one is. Danyel works with Claude Code on several PRs at once, and the state of each one used to live in chat scrollback. Now Claude writes down whose turn it is, what it needs from him, and how to test the change, on GitHub itself. The page only reads GitHub, so if it breaks or is thrown away, nothing is lost. The full reasoning is in `docs/superpowers/specs/2026-11-05-pr-board-design.md`.

The page is a Cloudflare Worker (a small program that Cloudflare runs for you) behind Cloudflare Access (Cloudflare's login gate, here set to let in only danyel@gmail.com through Google sign-in). Each item is a card with a stage strip, the questions to answer (each with a default in bold), and how to test the change. The board's one rule is that it never shows something as fine when it is waiting on Danyel: if the labels and the status section disagree, the card says "label out of sync" and counts as waiting on him. Danyel can answer on the page: each card waiting on him has its questions as choices, "How does it look?" on PRs waiting for his look, a note box and **Send answers**. The Worker posts the answers as one comment from his account and changes nothing else; the Claude session that handed the item over runs `cli/watch-answers.ts`, which picks the answer up within about two minutes; if no session does within 5 minutes, the service on the Mac (`cli/mac-service.ts`) starts a fresh one for it. Posting needs the Worker's token to have write access (step 1); without it, Send says so and nothing is posted.

## What you need

Node 24.2 or newer. The command-line tools and the hook run TypeScript files directly, and use `import.meta.main`, which older versions lack. `.nvmrc` names the version for `fnm` or `nvm`. Packages are installed with `pnpm`.

## Run the tests

```
pnpm install
pnpm test
pnpm typecheck
```

## Look at the page locally

Create a file named `.dev.vars` in the project root (it is git-ignored) with two lines:

```
GITHUB_TOKEN=<the output of: gh auth token>
ALLOW_LOCAL=1
```

`ALLOW_LOCAL=1` lets requests to `localhost` skip the Cloudflare Access check. It has no effect on any other hostname. Then run:

```
pnpm dev
```

Wrangler (Cloudflare's command-line tool) prints the address to open; it picks the port itself (add `--port N` to choose one). The `dev` script passes `--infer-origin-from-routes=false`: without it, because `wrangler.toml` has a `routes` line, Wrangler hands the Worker the live hostname instead of `localhost`, so `ALLOW_LOCAL` doesn't apply and every page is refused with 403. Run it as `pnpm dev`, not a bare `wrangler dev`.

## Going live

Nothing here has been run. Each step needs Danyel's OK. `docs/questions.md` lists the same steps as numbered questions, each with its default answer.

1. **Make a GitHub token for the Worker.** In GitHub, create a fine-grained personal access token with repository access set to all repositories, read-only access to metadata and contents, and read and write access to issues and pull requests. Make it from Danyel's own account: the board reads with it, and posts his answers with it, and the Worker checks that each answer went up as `ownerLogin`, because the watcher reads only that account's answers. Then store it as a Worker secret: `pnpm exec wrangler secret put GITHUB_TOKEN` (it prompts for the value, so it never lands in a file or your shell history). The Worker covers every repo this token can see that Danyel owns or collaborates on and that was pushed to in the last 60 days.
2. **Protect the page with Cloudflare Access.** In the Cloudflare dashboard (Zero Trust, then Access, then Applications), add a self-hosted application for the hostname you choose, with Google as the login method and a policy that allows only danyel@gmail.com. Copy the team domain (looks like `yourteam.cloudflareaccess.com`) and the application's AUD tag (a long identifier on the application's page) into `wrangler.toml`, replacing `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. In the same file, set the hostname in the `routes` line (it is `pr-board.danyelfisher.info`). `ALLOWED_EMAIL` is already set there.
3. **Deploy.** `pnpm exec wrangler deploy`. Do this only after step 2: with the placeholders still in `wrangler.toml` the page refuses everyone, which is safe but useless. `workers_dev` is off, so the page is reachable only through the route from step 2.
4. **Create the three labels** (`on danyel`, `parked` and `in-progress`) in each repo: `node cli/setup-labels.ts`. All three must exist in every repo the board reads, because the board takes whose turn it is from them. The script creates only the ones that are missing; add `--dry-run` first to see what it would do without changing anything. It runs as whichever account `gh` is logged in as, which may see different repos than the Worker's token. It also warns about repos whose merge settings copy the PR description into commit messages (the status section would leak into history).

   Before steps 5, 6 and 9, merge this branch and pull the main checkout (`/Users/danyel/code/MISC/pr-board`). The hook and the skill point at files in that main checkout by absolute path, and until the merge its `cli/` and `hooks/` folders don't exist.

5. **Turn on the Stop hook.** Add `/path/to/node /Users/danyel/code/MISC/pr-board/hooks/status-check.ts` as a second entry under `Stop` in `~/.claude/settings.json`. Use a stable Node 24 path, not a temporary one: `fnm exec --using=24 which node` prints one. (What `command -v node` prints in an ordinary shell is a temporary per-shell path under fnm; once that shell is gone the hook silently stops running and cards go stale.) When a Claude turn changes a PR or issue without updating its status, the hook stops the turn and asks Claude to update it.
6. **Install the skill** that teaches Claude to keep the status current and to watch for answers: `ln -s /Users/danyel/code/MISC/pr-board/skill/pr-status ~/.claude/skills/pr-status`. It uses the command-line helpers `cli/pr-status.ts` (`set`, `ok` and `show`) and `cli/watch-answers.ts`. If the repo moves, both the skill and the hook need editing.
7. **One-off pass over open items.** Look through the open PRs and issues and propose, for each, whether it is `on danyel` or `parked`, for Danyel to approve before any label is applied. There is no script for this yet; it is a conversation with Claude that ends with `node cli/pr-status.ts set ...` for each approved item.
8. **Let the token post answers.** If the token from step 1 was made read-only, edit it on GitHub (Settings, Developer settings, Fine-grained tokens) and give it read and write access to issues and pull requests. Its value doesn't change, so the Worker secret stays as it is.
9. **Install the Mac service**, which starts a fresh Claude session for an answer that no open session picked up within 5 minutes (before the board's 10, after which the card says "Answered, not picked up"). It claims the answer with a 👀, puts the item's worktree in place (creating it under the clone's `.claude/worktrees/` if there is none) and runs `claude -p` there with the answers in the prompt. It acts as Claude's own account (danyel-claude), using the token in `~/.config/claude-github/token` both for its own GitHub calls and for the session, and it starts sessions only in repos marked `git config claude.bot true`; in any other repo it refuses and says why in its log, since the session would act as danyelf. A session that ends without rewriting the item's status gets its claim taken back (the card says "Answered, not picked up" again), and that answer is not taken a second time; a session still running after `sessionMinutes` (60 by default) is stopped. It keeps the sessions it has running and the answers it gave back in `~/.pr-board/state.json`, so a restart doesn't lose them. Only `--dry-run --once` (sub-step 2) has been run; nothing is installed.
   1. Create `~/.pr-board/service.json` from `mac/service.example.json`, with one entry per repo giving the path of its main clone: `danyelf/torahmap` at `/Users/danyel/code/MISC/torahmap` and `danyelf/pr-board` at `/Users/danyel/code/MISC/pr-board`. The other settings in the example are the defaults and can be left out. `claudeArgs` adds flags to every `claude -p` it runs. A session started this way can't stop to ask for permission, so without a `--permission-mode` it can do only what your settings already allow; `"claudeArgs": ["--permission-mode", "auto"]` gives it the mode you work in (question 14 in `docs/questions.md`).
   2. Try it without changing anything: `node /Users/danyel/code/MISC/pr-board/cli/mac-service.ts --dry-run --once`. It reads GitHub, says how many items in each repo it checked, and for each answer it would take prints the worktree it would use or create, the command, and the whole prompt. It claims nothing, creates nothing and starts nothing.
   3. Make the folder for its log: `mkdir -p ~/.pr-board`. Copy `mac/pr-board.mac-service.plist` to `~/Library/LaunchAgents/` and, in the copy, replace `__NODE__` with the Node path from step 5, `__REPO__` with `/Users/danyel/code/MISC/pr-board`, `__LOG_DIR__` with `/Users/danyel/.pr-board`, and `__PATH__` with the directory of that `__NODE__` first, then the directories of `pnpm` and `claude`, then where `gh` and `git` are, for example `<the directory of __NODE__>:/opt/homebrew/bin:/Users/danyel/.local/bin:/usr/bin:/bin`. launchd gives programs almost no `PATH` of their own, and the sessions inherit this one: with Homebrew's directory ahead of the Node 24 one, a session's `node` is Homebrew's Node 26, not 24. Check with `which -a node pnpm claude gh git`.
   4. Start it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/pr-board.mac-service.plist`. It starts again at every login and if it ever stops. Check it with `launchctl print gui/$(id -u)/local.pr-board.mac-service` and `tail -f ~/.pr-board/mac-service.log`; each session it starts writes its output to its own file in `~/.pr-board/logs/`. To stop it: `launchctl bootout gui/$(id -u)/local.pr-board.mac-service`. Sessions it already started keep running.
   5. Before calling it installed, let launchd start one real session and read its log in `~/.pr-board/logs/`: it must have run `claude` in the right worktree as danyel-claude, with the Node and `pnpm` you expect. The dry run doesn't start a process, so it can't show a `PATH` or permission problem under launchd.

## Where things are

- `pr-board.config.json` the person the board is for: `ownerName` spells the status section and the `on <name>` label, and `ownerLogin` is the GitHub account asked to review a PR handed to them. The code never names anyone; the tests use `test/fixtures/pr-board.config.json`, with a different person, so a name written into the code fails them. (The Worker's sign-in address is separate: `ALLOWED_EMAIL` in `wrangler.toml`.)
- `src/worker/` the Worker: GitHub reading, the Access check, page rendering, and `post-answer.ts`, which checks and posts answers.
- `src/shared/` the rules for whose turn it is, stages, and the status section (written as text and, on its last line, as data), `answer.ts` for the answer comment's format, `fingerprint.ts` for the short fingerprint of what a status asks, plus `names.ts` for the label names and other values several parts must agree on.
- `cli/` `pr-status.ts` (Claude writes the status), `watch-answers.ts` (Claude waits for answers), `mac-service.ts` (the always-on service that starts a session for answers nobody picked up) and `setup-labels.ts`.
- `mac/` the launchd agent template for the service and an example of its config file.
- `hooks/status-check.ts` the Stop hook. `skill/pr-status/` the skill.
- `test/` the tests, with recorded GitHub responses under `test/fixtures/`.
