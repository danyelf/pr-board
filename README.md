# PR Board

PR Board is a single web page that lists the pull requests (PRs) and issues Danyel has in flight across his GitHub repos, and says where each one is and whose turn it is. Danyel works with Claude Code on several PRs at once. For each piece of work, Claude writes down which of three gates it is in (design, implementation, prep for merge), what state it is in there, what it needs from him, and how to test the change. That record lives in the board's own database. GitHub keeps what it owns (the PR, its commits and checks, whether it can merge), and the board reads that fresh. The design is in `docs/superpowers/specs/2026-11-20-gates-and-board-state-design.md`.

The page is a Cloudflare Worker (a small program that Cloudflare runs for you) behind Cloudflare Access (Cloudflare's login gate, here set to let in only danyel@gmail.com). Each card shows its gates, the questions to answer (each with a default in bold), how to test the change, a note box and **Send**. The board's one rule is that it never shows something as fine when it is waiting on Danyel. His answers are stored by the board; the Claude session that handed the item over runs `cli/watch-answers.ts`, which picks the answer up within about a minute. If no session does within 5 minutes, the service on the Mac (`cli/mac-service.ts`) starts a fresh session for it.

Claude's side (the status command, the watcher, the end-of-turn hook and the Mac service) talks to the board over a small HTTP interface under `/api`, signed in with a Cloudflare Access service token: a client id and secret that Access checks in place of a person's sign-in. If the board can't be reached, or refuses, each of them prints a line starting with ⚠️ and fails. None of them ever falls back to writing on GitHub.

## What you need

Node 24.2 or newer. The command-line tools and the hook run TypeScript files directly, and use `import.meta.main`, which older versions lack. `.nvmrc` names the version for `fnm` or `nvm`. Packages are installed with `pnpm`.

## Run the tests

```
pnpm install
pnpm test
pnpm typecheck
pnpm build:page
```

`build:page` bundles the page's script and styles into `dist/page`, which the Worker serves.

## Look at the page locally

Create a file named `.dev.vars` in the project root (it is git-ignored) with two lines:

```
GITHUB_TOKEN=<danyel-claude's token>
ALLOW_LOCAL=1
```

`ALLOW_LOCAL=1` lets requests to `localhost` skip the Cloudflare Access check. It has no effect on any other hostname. A local request counts as Danyel, or as Claude's side when it carries the header `X-Local-Caller: claude`, which is how to try the `/api` routes with `curl`.

The board keeps its records in a D1 database (Cloudflare's SQLite database). Create the local copy's tables before the first run:

```
pnpm exec wrangler d1 migrations apply pr-board --local
```

To see cards without real work on the board, load the made-up ones from the design's sketches. It empties the local tables first, so it can be run again:

```
pnpm exec wrangler d1 execute pr-board --local --file test/fixtures/seed.sql
```

Then run:

```
pnpm build:page
pnpm dev
```

Wrangler (Cloudflare's command-line tool) prints the address to open; it picks the port itself (add `--port N` to choose one). The `dev` script passes `--infer-origin-from-routes=false`: without it, because `wrangler.toml` has a `routes` line, Wrangler hands the Worker the live hostname instead of `localhost`, so `ALLOW_LOCAL` doesn't apply and every page is refused with 403. Run it as `pnpm dev`, not a bare `wrangler dev`.

## Going live

These steps set the board up from nothing.

1. **Give the Worker danyel-claude's GitHub token.** The Worker only reads GitHub and sets the board's labels; it never posts as anyone. So it runs on Claude's account (danyel-claude), not Danyel's. The token needs to read the repos danyel-claude is a collaborator on, and to write issues and pull requests, which setting labels needs. The token danyel-claude's sessions already use (the one in the Mac service's `tokenFile`) has that access. Store it as a Worker secret: `pnpm exec wrangler secret put GITHUB_TOKEN` (it prompts for the value, so it never lands in a file or your shell history). If the secret still holds Danyel's own token from the first design, this replaces it, and that token can be revoked. The board lists every repo this token can see that was pushed to in the last 60 days, plus any repo with an open record on the board.
2. **Protect the page with Cloudflare Access.** In the Cloudflare dashboard (Zero Trust, then Access, then Applications), add a self-hosted application for the hostname you choose, with a policy that allows only danyel@gmail.com. Copy the team domain (looks like `yourteam.cloudflareaccess.com`) and the application's AUD tag (a long identifier on the application's page) into `wrangler.toml`, as `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. In the same file, set the hostname in the `routes` line (it is `pr-board.danyelfisher.info`). `ALLOWED_EMAIL` is already set there.
3. **Make the service token for Claude's side.**
   1. In the dashboard (Zero Trust, then Access, then Service Auth, then Service Tokens), create a service token. Choose how long it lasts: a year is the default, and it can be set to never expire. Cloudflare shows the client secret only once, so copy both the client id and the secret now.
   2. On the board's Access application from step 2, add a second policy with the action **Service Auth** that includes that service token. Without it, Access sends the token's requests to the login page.
   3. Put the client id in `wrangler.toml` as `SERVICE_CLIENT_ID`. The Worker treats a request as Claude's only when Access vouches for a service token with this id; while it is empty, nothing counts as Claude's side.
   4. On the Mac, save both values in `~/.config/pr-board/access-token.json`, as `{"clientId": "…", "clientSecret": "…"}`, and make the file readable only by you: `chmod 600 ~/.config/pr-board/access-token.json`. To keep it elsewhere, set `PR_BOARD_ACCESS_FILE` to its path. The status command, the watcher, the hook and the Mac service all read it.
   5. Check that `boardUrl` in `pr-board.config.json` is the board's address (`https://pr-board.danyelfisher.info`). That is where Claude's side sends its requests.

   When the service token expires or is revoked, every command fails with a ⚠️ line naming this file. Make a new token as in 3.1, add it to the Service Auth policy, update `SERVICE_CLIENT_ID` and redeploy, and put the new values in the file.
4. **Create the D1 database.** `pnpm exec wrangler d1 create pr-board` prints a `database_id`; put it in `wrangler.toml` in place of `<filled at switch-over>`. Then create the tables: `pnpm exec wrangler d1 migrations apply pr-board --remote`. Run the same command again whenever a new file appears under `migrations/`.
5. **Deploy.** `pnpm exec wrangler deploy`. It builds the page first. Do this only after steps 2 to 4: with the Access placeholders still in `wrangler.toml` the page refuses everyone, which is safe but useless. `workers_dev` is off, so the page is reachable only through the route from step 2.
6. **Create the labels** in each repo: `node cli/setup-labels.ts`. The board writes `gate: design`, `gate: implementation`, `gate: prep`, `on <owner>` (from `ownerName` in `pr-board.config.json`), `ready to merge` and `parked` as a copy of each record, so people scanning the PR list on GitHub see the gate and whose turn it is; nothing reads them back. The script also creates `in-progress`, which people and sessions set themselves and the board never touches. It creates only the ones that are missing; add `--dry-run` first to see what it would do. It runs as whichever account `gh` is logged in as, which may see different repos than the Worker's token.

   Before the remaining steps, merge this branch and pull the main checkout (`/Users/danyel/code/MISC/pr-board`). The hook and the skill point at files in that main checkout by absolute path.

7. **Turn on the Stop hook.** Add `/path/to/node /Users/danyel/code/MISC/pr-board/hooks/status-check.ts` as a second entry under `Stop` in `~/.claude/settings.json`. Use a stable Node 24 path, not a temporary one: `fnm exec --using=24 which node` prints one. (What `command -v node` prints in an ordinary shell is a temporary per-shell path under fnm; once that shell is gone the hook silently stops running and cards go stale.) When a Claude turn changes a PR or issue without writing or confirming its status on the board, the hook stops the turn and asks Claude to do it. If the check itself fails (the board can't be reached, or gh fails), it stops the turn once and says why.
8. **Install the skill** that teaches Claude to write statuses and to watch for answers: `ln -s /Users/danyel/code/MISC/pr-board/skill/pr-status ~/.claude/skills/pr-status`. It uses `cli/pr-status.ts` (`set`, `ok` and `show`) and `cli/watch-answers.ts`. If the repo moves, both the skill and the hook need editing.
9. **Move the open work over, once.** Claude reads each open PR and labelled issue and proposes its gate, state, approvals and ask. Danyel approves the list before anything is written. For each approved item, Claude writes the record as JSON and loads it with `node cli/pr-status.ts import <owner/repo#N> --json <file>`; this is the only way a record gets approvals without an answer from Danyel on the board, and it is not for use afterwards. Then remove the old status sections from GitHub, running as danyel-claude: first `node cli/remove-old-status.ts --dry-run <owner/repo> …` to see what it would change, then the same without `--dry-run`. It removes the status section from each open PR's description, and deletes the status comments danyel-claude wrote on open issues. It leaves anyone else's comments alone, and says so.
10. **Install the Mac service**, which starts a fresh Claude session, in the item's worktree and as danyel-claude, for an answer that no open session picked up in time; if that session doesn't write a new status, the item comes back to Danyel as "A Mac session gave up on your answers". It asks the board for answers, so it needs the service token file from step 3. How it works is in the design, under "The Mac service". Every line of its log about an item starts with that item, so `grep danyelf/torahmap#564 ~/.pr-board/mac-service.log` tells that item's story.
    1. Create `~/.pr-board/service.json` from `mac/service.example.json`, with one entry per repo giving the path of its main clone: `danyelf/torahmap` at `/Users/danyel/code/MISC/torahmap` and `danyelf/pr-board` at `/Users/danyel/code/MISC/pr-board`. The other settings in the example are the defaults and can be left out. `claudeArgs` adds flags to every `claude -p` it runs. A session started this way can't stop to ask for permission, so without a `--permission-mode` it can do only what your settings already allow; so set `"claudeArgs": ["--permission-mode", "auto"]`, the mode you work in (Danyel's choice). A sign-in from `claude auth login` ends after a few weeks, so give the sessions a long-lived one: put the token `claude setup-token` prints in a file only you can read, such as `~/.config/claude-code/oauth-token`, and set `"claudeTokenFile"` to that path. Each session gets it as `CLAUDE_CODE_OAUTH_TOKEN`; while the file is missing or empty, the service starts no sessions.
    2. Try it without changing anything: `node /Users/danyel/code/MISC/pr-board/cli/mac-service.ts --dry-run --once`. It asks the board for answers waiting past the grace period, and for each one it would take prints the worktree it would use or create, the command, and the whole prompt. It claims nothing, writes nothing to the board, creates nothing and starts nothing.
    3. Make the folder for its log: `mkdir -p ~/.pr-board`. Copy `mac/pr-board.mac-service.plist` to `~/Library/LaunchAgents/` and, in the copy, replace `__NODE__` with the Node path from step 7, `__REPO__` with `/Users/danyel/code/MISC/pr-board`, `__LOG_DIR__` with `/Users/danyel/.pr-board`, and `__PATH__` with the directory of that `__NODE__` first, then the directories of `pnpm` and `claude`, then where `gh` and `git` are, for example `<the directory of __NODE__>:/opt/homebrew/bin:/Users/danyel/.local/bin:/usr/bin:/bin`. launchd gives programs almost no `PATH` of their own, and the sessions inherit this one: with Homebrew's directory ahead of the Node 24 one, a session's `node` is Homebrew's Node 26, not 24. Check with `which -a node pnpm claude gh git`.
    4. Start it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/pr-board.mac-service.plist`. It starts again at every login and if it ever stops. Check it with `launchctl print gui/$(id -u)/local.pr-board.mac-service` and `tail -f ~/.pr-board/mac-service.log`; each session it starts writes its output to its own file in `~/.pr-board/logs/`. To stop it: `launchctl bootout gui/$(id -u)/local.pr-board.mac-service`. Sessions it already started keep running.
    5. Before calling it installed, let launchd start one real session and read its log in `~/.pr-board/logs/`: it must have run `claude` in the right worktree as danyel-claude, with the Node and `pnpm` you expect, signed in with your subscription. While it runs, `ps -axww -o pid=,etime=,args= | grep -- '--name'` should show it as `<the claude path from service.json> --name danyelf/<repo>#<n> answers -p …`, which is how the service finds it: if the line starts with anything else (a symlink's target, or `node` running a script), the service can't see its sessions, so set `claude` in `service.json` to what `ps` shows. The dry run doesn't start a process, so it can't show a `PATH` or permission problem under launchd.

## Where things are

- `pr-board.config.json` the person the board is for and where the board is: `ownerName` spells the `on <name>` label, `ownerLogin` is the GitHub account asked to review a PR handed to them, and `boardUrl` is the address Claude's side calls. The code never names anyone; the tests use `test/fixtures/pr-board.config.json`, with a different person, so a name written into the code fails them. (The Worker's sign-in address is separate: `ALLOWED_EMAIL` in `wrangler.toml`.)
- `src/worker/` the Worker: a small page shell, the `/api/…` routes, GitHub reading, the Access check and the D1 store.
- `src/page/` the page's own code, which runs in the browser and is built into `dist/page` by `pnpm build:page`.
- `src/shared/` what the Worker, the page and the command-line tools share: the rules for gates, states and answers (`work.ts`), how a card is drawn from a record and GitHub's facts (`view.ts`), the labels the board writes (`labels.ts`), and `names.ts` for the label names and other values several parts must agree on.
- `migrations/` the D1 tables.
- `cli/` `pr-status.ts` (Claude writes the status), `watch-answers.ts` (Claude waits for answers), `mac-service.ts` (the always-on service that starts a session for answers nobody picked up), `board.ts` (how they all call the board with the service token), `answers.ts` (printing answers, shared by the watcher and the service), `poll.ts` (their timings and back-off), `setup-labels.ts`, and `remove-old-status.ts` (the one-off clean-up of the first design's status sections).
- `mac/` the launchd agent template for the service and an example of its config file.
- `hooks/status-check.ts` the Stop hook. `skill/pr-status/` the skill.
- `test/` the tests, with recorded GitHub responses and the local seed data under `test/fixtures/`.
