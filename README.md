# PR Board

PR Board is a single web page that lists the pull requests (PRs) and issues Danyel has in flight across his GitHub repos, and says whose turn each one is. Danyel works with Claude Code on several PRs at once, and the state of each one used to live in chat scrollback. Now Claude writes down whose turn it is, what it needs from him, and how to test the change, on GitHub itself. The page only reads GitHub, so if it breaks or is thrown away, nothing is lost. The full reasoning is in `docs/superpowers/specs/2026-11-05-pr-board-design.md`.

The page is a Cloudflare Worker (a small program that Cloudflare runs for you) behind Cloudflare Access (Cloudflare's login gate, here set to let in only danyel@gmail.com through Google sign-in). Each item is a card with a stage strip, the questions to answer (each with a default in bold), and how to test the change. The board's one rule is that it never shows something as fine when it is waiting on Danyel: if the labels and the status section disagree, the card says "label out of sync" and counts as waiting on him. This is part 1, a board you can read. Answering questions from the page is not built yet.

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

Wrangler (Cloudflare's command-line tool) prints the address to open; it picks the port itself.

## Going live

Nothing here has been run. Each step needs Danyel's OK. `docs/questions.md` lists the same steps as numbered questions, each with its default answer.

1. **Make a GitHub token for the Worker.** In GitHub, create a fine-grained personal access token with repository access set to all repositories, and read-only access to metadata, contents, issues and pull requests. Then store it as a Worker secret: `pnpm exec wrangler secret put GITHUB_TOKEN` (it prompts for the value, so it never lands in a file or your shell history). The Worker covers every repo this token can see that Danyel owns or collaborates on and that was pushed to in the last 60 days.
2. **Protect the page with Cloudflare Access.** In the Cloudflare dashboard (Zero Trust, then Access, then Applications), add a self-hosted application for the hostname you choose, with Google as the login method and a policy that allows only danyel@gmail.com. Copy the team domain (looks like `yourteam.cloudflareaccess.com`) and the application's AUD tag (a long identifier on the application's page) into `wrangler.toml`, replacing `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. In the same file, uncomment the `routes` line and set the hostname (the file suggests `board.danyelfisher.info`, still to be confirmed). `ALLOWED_EMAIL` is already set there.
3. **Deploy.** `pnpm exec wrangler deploy`. Do this only after step 2: with the placeholders still in `wrangler.toml` the page refuses everyone, which is safe but useless. `workers_dev` is off, so the page is reachable only through the route from step 2.
4. **Create the three labels** (`on danyel`, `parked` and `in-progress`) in each repo: `node cli/setup-labels.ts`. All three must exist in every repo the board reads, because the board takes whose turn it is from them. The script creates only the ones that are missing; add `--dry-run` first to see what it would do without changing anything. It runs as whichever account `gh` is logged in as, which may see different repos than the Worker's token. It also warns about repos whose merge settings copy the PR description into commit messages (the status section would leak into history).

   Before steps 5 and 6, merge this branch and pull the main checkout (`/Users/danyel/code/MISC/pr-board`). The hook and the skill point at files in that main checkout by absolute path, and until the merge its `cli/` and `hooks/` folders don't exist.

5. **Turn on the Stop hook.** Add `/path/to/node /Users/danyel/code/MISC/pr-board/hooks/status-check.ts` as a second entry under `Stop` in `~/.claude/settings.json`. Use a stable Node 24 path, not a temporary one: `fnm exec --using=24 which node` prints one. (What `command -v node` prints in an ordinary shell is a temporary per-shell path under fnm; once that shell is gone the hook silently stops running and cards go stale.) When a Claude turn changes a PR or issue without updating its status, the hook stops the turn and asks Claude to update it.
6. **Install the skill** that teaches Claude to keep the status current: `ln -s /Users/danyel/code/MISC/pr-board/skill/pr-status ~/.claude/skills/pr-status`. It uses the command-line helper `cli/pr-status.ts` (`set`, `ok` and `show`). If the repo moves, both the skill and the hook need editing.
7. **One-off pass over open items.** Look through the open PRs and issues and propose, for each, whether it is `on danyel` or `parked`, for Danyel to approve before any label is applied. There is no script for this yet; it is a conversation with Claude that ends with `node cli/pr-status.ts set ...` for each approved item.

## Where things are

- `pr-board.config.json` names the person the board is for (`ownerName`). The status section and the `on <name>` label are spelled from it; the code itself never names anyone. The tests use `test/fixtures/pr-board.config.json`, with a different name, so a name written into the code fails them.

- `src/worker/` the Worker: GitHub reading, the Access check, page rendering.
- `src/shared/` the rules for whose turn it is, stages, and the status section, plus `names.ts` for the label names and other values several parts must agree on.
- `cli/` `pr-status.ts` (Claude writes the status) and `setup-labels.ts`.
- `hooks/status-check.ts` the Stop hook. `skill/pr-status/` the skill.
- `test/` the tests, with recorded GitHub responses under `test/fixtures/`.
