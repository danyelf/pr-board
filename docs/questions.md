# Questions for Danyel

Collected while building part 1 (a board you can read). Newest at the bottom. Each one says what I did in the meantime.

## Noticed along the way

1. **This Claude session isn't running as danyel-claude.** Settled: the token loads only in repos marked `git config claude.bot true`, and this repo now is. Claude checks `gh api user` before posting.

## Go-live steps prepared by the build

All the go-live steps are done (2026-11-08). They are in the order they were done. The steps themselves are written out once, in `README.md` under "Going live"; each question here names its step and gives only the decision and my default, in bold.

2. **Make the GitHub token for the Worker?** Done: a fine-grained token from your account (read-only contents; issues and pull requests read-only at first, read and write since answering), stored as the Worker secret `GITHUB_TOKEN` by piping it in with `pbpaste`, because `wrangler secret put` run through Claude's `!` has no terminal to ask for it.

3. **Which hostname, and shall I set up the login gate?** Done: `pr-board.danyelfisher.info`, behind the Cloudflare Access application of the team `fisherinsights.cloudflareaccess.com`, with a one-time emailed code as the login.

4. **Deploy?** Done from `main`. Without signing in, the page sends you to the Cloudflare login; signed in, it shows the board.

5. **Create the three labels?** Done. All three now exist in the four repos danyel-claude can see (pr-board, torahmap, danyelfisher.info, ieeevis-scrape); no merge-setting warnings. The script runs as danyel-claude, so a repo it isn't a collaborator on gets no labels: run it again from your own account, or add danyel-claude, if the Worker's token sees more repos.

6. **Turn on the Stop hook?** Done: you added it to `~/.claude/settings.json` yourself, since auto mode doesn't let Claude edit its own settings (README step 5).

7. **Install the skill?** Done: `~/.claude/skills/pr-status` links to `skill/pr-status` in the main checkout.

8. **Shall I do the one-off pass over open items?** Done, with your approval: torahmap #594, #593 and #564 are `on danyel` with status sections, #411 stays `parked`, and #463 lost its `in-progress` label (to be decided later).

## Design questions the build turned up

9. **Should cards show the "Ask" line?** Answered: yes. Cards show the status section's `Ask:` line as one line under the title.

10. **Some commits still ask for your approval.** Most likely settled: the commit example used `git -c user.name=…`, which your allowlist doesn't cover. With a plain `git -C <path> commit`, commits since 2026-11-06 have gone through without a prompt. If one prompts again, the prompt's wording should name the check.

## Answering from the board

11. **Make the owner token, which posts your answers?** Done differently: there is no second token. You gave the board's existing `GITHUB_TOKEN` write access to issues and pull requests (2026-11-08), and the Worker posts with it (README step 8).

12. **Are the calls I made for answering right?** (**yes** | let's talk) They are written down in the design under "Settled for answering", each marked as my call. The ones most worth a look: the Worker never changes whose turn it is or the status (the board works out "answered" from your comment being newer than the status); the status section carries a hidden data line, used only while the text still matches it, so a hand edit on GitHub is read from the text and tagged on the card; and an answer with no 👀 after 10 minutes puts the card back at the top.

## The Mac service

13. **Install the Mac service?** (**yes, after trying `--dry-run --once`** | wait) README step 9. It starts a fresh Claude session for an answer no open session picked up within 5 minutes. I haven't created `~/.pr-board/service.json` or installed anything into launchd. I did run it once with `--dry-run --once` against torahmap and pr-board, from a config file in my scratch folder: it read the five items carrying `on danyel` (three in torahmap, two in pr-board), found no answers, and changed nothing. My calls for it are in the design under "Settled for the Mac service"; the one most worth a look is that it uses Claude's token for its own GitHub calls too, because under launchd `gh` would otherwise act as you.

14. **Which permission mode should its sessions run in?** (**auto, the mode you work in** | acceptEdits | none) Set with `"claudeArgs": ["--permission-mode", "auto"]` in `service.json`. A `claude -p` session can't stop to ask, so with no mode it can do only what your settings already allow, and will likely stall on its first push or edit. The default in the code is no extra flags, so nothing is chosen for you.
