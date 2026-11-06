# Questions for Danyel

Collected while building part 1 (a board you can read). Newest at the bottom. Each one says what I did in the meantime.

## Noticed along the way

1. **This Claude session isn't running as danyel-claude.** Your global instructions say my GitHub activity goes through the danyel-claude account via `GH_TOKEN`, but in this session `GH_TOKEN` is unset and `gh` is logged in as danyelf. I've only done reads on GitHub (no posts), so nothing went out under your name. Worth checking why the token didn't load here; the status helper relies on it to post as danyel-claude.

## Go-live steps prepared by the build

Nothing below has been run. Each needs your OK. They are in the order to do them, and the same steps are in `README.md` under "Going live". Each question has its default in bold.

2. **Make the GitHub token for the Worker?** (**yes** | wait) In GitHub (Settings, Developer settings, Fine-grained tokens), create a token with repository access set to all repositories and read-only access to metadata, contents, issues and pull requests. Then store it: `pnpm exec wrangler secret put GITHUB_TOKEN` (it prompts for the value, so it never lands in a file or your shell history). The Worker covers every repo this token can see where you are owner or collaborator and which was pushed to in the last 60 days. I haven't created a token or set a secret.

3. **Which hostname, and shall I set up the login gate?** (**board.danyelfisher.info** | another name) `wrangler.toml` has the route commented out, with `board.danyelfisher.info` as the suggestion. In the Cloudflare dashboard (Zero Trust, Access, Applications) add a self-hosted application for that hostname, with Google as the login method and a policy allowing only danyel@gmail.com. Then put the team domain (like `yourteam.cloudflareaccess.com`) and the application's AUD tag into `wrangler.toml` as `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, replacing the two `REPLACE-…` placeholders, and uncomment the line `routes = [{ pattern = "board.danyelfisher.info", custom_domain = true }]` with your chosen name. `ALLOWED_EMAIL` is already `danyel@gmail.com`. The Worker refuses every request that lacks a valid Access token for that application and email. Please don't deploy before this step: with the placeholders in place the page would simply refuse everyone, which is safe but useless.

4. **Deploy?** (**yes, after 2 and 3** | wait) `pnpm exec wrangler deploy`. `workers_dev` is off, so the page is reachable only through the route from question 3.

5. **Create the two new labels?** (**yes** | wait) `node cli/setup-labels.ts` creates `on danyel` and `parked` in every repo your `gh` account can see (owner or collaborator, pushed to in the last 60 days). It runs as whichever account `gh` is logged in as, which may see different repos than the Worker's token. It also warns about any repo whose merge settings copy the PR description into commit messages (the status section would leak into history). The dry run, which only reads (`node cli/setup-labels.ts --dry-run`), printed:

   ```
   danyelf/torahmap: would create "on danyel"
   danyelf/torahmap: would create "parked"
   danyelf/danyelfisher.info: would create "on danyel"
   danyelf/danyelfisher.info: would create "parked"
   danyelf/ieeevis-scrape: would create "on danyel"
   danyelf/ieeevis-scrape: would create "parked"
   ```

   No merge-setting warnings. To do it for real: `node cli/setup-labels.ts`.

6. **Turn on the Stop hook?** (**yes** | wait) Add a second entry to the `Stop` hooks in `~/.claude/settings.json`:

   ```json
   {"type":"command","command":"/Users/danyel/.local/state/fnm_multishells/15884_1793769790861/bin/node /Users/danyel/code/MISC/pr-board/hooks/status-check.ts"}
   ```

   That node path (from `command -v node`) is a temporary fnm shell path and will stop working. Use a stable Node 24 path instead (for example the fnm default alias, or whatever `fnm exec --using=24 which node` prints). The hook needs Node 24 because it runs the TypeScript directly.

7. **Install the skill?** (**yes** | wait) `ln -s /Users/danyel/code/MISC/pr-board/skill/pr-status ~/.claude/skills/pr-status`. One thing to know: the skill and the hook both name `/Users/danyel/code/MISC/pr-board/cli/pr-status.ts` by absolute path, so they point at this checkout. If the repo moves or the main checkout isn't where the merged code ends up, they need updating.

8. **Shall I do the one-off pass over open items?** (**yes, as a proposal only** | skip) For each open PR and issue I would propose `on danyel` or `parked` and why, and wait for your approval before touching any label. There is no script for this; the build has no command for a bulk pass. Once you approve an item I would apply it with `node /Users/danyel/code/MISC/pr-board/cli/pr-status.ts set <owner/repo#N> --waiting danyel|nobody --ask "…"`, which also writes the status section. Until then every open item shows on the page as having no turn label, which is deliberate: the page never claims "Claude working" without a label saying so.

## Design questions the build turned up

9. **Should cards show the "Ask" line?** (**yes, one line under the title** | leave out) Each status section has an `Ask:` line ("look at the preview, and answer one question"). The plan didn't list it among card contents, so cards don't show it: they show the why-tag, stage strip, test protocol and questions. I'd add it as one line under the title. Your call.

10. **Some commits still ask for your approval.** Claude Code's own check (logged as `hook:tool.check`, not one of your hooks; I tested each) prompts on some `git commit` calls even in auto mode with `Bash(git commit:*)` allowed. It isn't the `cd` chains (fixed), line breaks, or the working folder. Next time one appears, the wording of the prompt should name the check.
