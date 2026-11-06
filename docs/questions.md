# Questions for Danyel

Collected while building part 1 (a board you can read). Newest at the bottom. Each one says what I did in the meantime.

## Noticed along the way

1. **This Claude session isn't running as danyel-claude.** Your global instructions say my GitHub activity goes through the danyel-claude account via `GH_TOKEN`, but in this session `GH_TOKEN` is unset and `gh` is logged in as danyelf. I've only done reads on GitHub (no posts), so nothing went out under your name. Worth checking why the token didn't load here; the status helper relies on it to post as danyel-claude.

## Go-live steps prepared by the build

Nothing below has been run. Each needs your OK. They are in the order to do them. The steps themselves are written out once, in `README.md` under "Going live"; each question here names its step and gives only the decision and my default, in bold.

2. **Make the GitHub token for the Worker?** (**yes** | wait) README step 1. I haven't created a token or set a secret.

3. **Which hostname, and shall I set up the login gate?** (**board.danyelfisher.info** | another name) README step 2. `wrangler.toml` has the route commented out, with `board.danyelfisher.info` as the suggestion. I haven't changed anything in Cloudflare.

4. **Deploy?** (**yes, after 2 and 3** | wait) README step 3.

5. **Create the three labels?** (**yes** | wait) README step 4. The dry run, which only reads (`node cli/setup-labels.ts --dry-run`), printed this when only two labels were wanted (`in-progress` is now checked too):

   ```
   danyelf/torahmap: would create "on danyel"
   danyelf/torahmap: would create "parked"
   danyelf/danyelfisher.info: would create "on danyel"
   danyelf/danyelfisher.info: would create "parked"
   danyelf/ieeevis-scrape: would create "on danyel"
   danyelf/ieeevis-scrape: would create "parked"
   ```

   No merge-setting warnings.

6. **Turn on the Stop hook?** (**yes, after merging this branch and pulling the main checkout** | wait) README step 5. The hook file lives in the main checkout, which has no `hooks/` folder until the merge.

7. **Install the skill?** (**yes, after merging this branch and pulling the main checkout** | wait) README step 6. Until the merge, the main checkout has no `skill/` folder, so the link would point at nothing.

8. **Shall I do the one-off pass over open items?** (**yes, as a proposal only** | skip) README step 7. For each open PR and issue I would propose `on danyel` or `parked` and why, and wait for your approval before touching any label. Until then every open item shows on the page as having no turn label, which is deliberate: the page never claims "Claude working" without a label saying so.

## Design questions the build turned up

9. **Should cards show the "Ask" line?** Answered: yes. Cards show the status section's `Ask:` line as one line under the title.

10. **Some commits still ask for your approval.** Claude Code's own check (logged as `hook:tool.check`, not one of your hooks; I tested each) prompts on some `git commit` calls even in auto mode with `Bash(git commit:*)` allowed. It isn't the `cd` chains (fixed), line breaks, or the working folder. Next time one appears, the wording of the prompt should name the check.
