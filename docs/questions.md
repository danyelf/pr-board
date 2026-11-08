# Questions for Danyel

Collected while building part 1 (a board you can read). Newest at the bottom. Each one says what I did in the meantime.

## Noticed along the way

1. **This Claude session isn't running as danyel-claude.** Settled: the token loads only in repos marked `git config claude.bot true`, and this repo now is. Claude checks `gh api user` before posting.

## Go-live steps prepared by the build

Steps 5 to 8 are done (2026-11-08); steps 2 to 4, deploying, have not been run. Each needs your OK. They are in the order to do them. The steps themselves are written out once, in `README.md` under "Going live"; each question here names its step and gives only the decision and my default, in bold.

2. **Make the GitHub token for the Worker?** (**yes** | wait) README step 1. I haven't created a token or set a secret.

3. **Which hostname, and shall I set up the login gate?** (**board.danyelfisher.info** | another name) README step 2. `wrangler.toml` has the route commented out, with `board.danyelfisher.info` as the suggestion. I haven't changed anything in Cloudflare.

4. **Deploy?** (**yes, after 2 and 3** | wait) README step 3.

5. **Create the three labels?** Done. All three now exist in the four repos danyel-claude can see (pr-board, torahmap, danyelfisher.info, ieeevis-scrape); no merge-setting warnings. The script runs as danyel-claude, so a repo it isn't a collaborator on gets no labels: run it again from your own account, or add danyel-claude, if the Worker's token sees more repos.

6. **Turn on the Stop hook?** Done: you added it to `~/.claude/settings.json` yourself, since auto mode doesn't let Claude edit its own settings (README step 5).

7. **Install the skill?** Done: `~/.claude/skills/pr-status` links to `skill/pr-status` in the main checkout.

8. **Shall I do the one-off pass over open items?** Done, with your approval: torahmap #594, #593 and #564 are `on danyel` with status sections, #411 stays `parked`, and #463 lost its `in-progress` label (to be decided later).

## Design questions the build turned up

9. **Should cards show the "Ask" line?** Answered: yes. Cards show the status section's `Ask:` line as one line under the title.

10. **Some commits still ask for your approval.** Most likely settled: the commit example used `git -c user.name=…`, which your allowlist doesn't cover. With a plain `git -C <path> commit`, commits since 2026-11-06 have gone through without a prompt. If one prompts again, the prompt's wording should name the check.
