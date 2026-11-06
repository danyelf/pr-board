# Questions for Danyel

Collected while building part 1 (a board you can read). Newest at the bottom. Each one says what I did in the meantime.

## Noticed along the way

1. **This Claude session isn't running as danyel-claude.** Your global instructions say my GitHub activity goes through the danyel-claude account via `GH_TOKEN`, but in this session `GH_TOKEN` is unset and `gh` is logged in as danyelf. I've only done reads on GitHub (no posts), so nothing went out under your name. Worth checking why the token didn't load here; the status helper relies on it to post as danyel-claude.

## Go-live steps prepared by the build

Nothing below has been run. Each needs your OK.

2. **Create the two new labels.** `node cli/setup-labels.ts` creates `on danyel` and `parked` in every repo your `gh` account can see (owner or collaborator, pushed to in the last 60 days). It runs as whichever account `gh` is logged in as, which may see different repos than the Worker's token. It also warns about any repo whose merge settings copy the PR description into commit messages (the status section would leak into history). The dry run, which only reads, printed:

   ```
   danyelf/torahmap: would create "on danyel"
   danyelf/torahmap: would create "parked"
   danyelf/danyelfisher.info: would create "on danyel"
   danyelf/danyelfisher.info: would create "parked"
   danyelf/ieeevis-scrape: would create "on danyel"
   danyelf/ieeevis-scrape: would create "parked"
   ```

   No merge-setting warnings. To do it for real: `node cli/setup-labels.ts`.

3. **Turn on the Stop hook.** Add a second entry to the `Stop` hooks in `~/.claude/settings.json`:

   ```json
   {"type":"command","command":"/Users/danyel/.local/state/fnm_multishells/15884_1793769790861/bin/node /Users/danyel/code/MISC/pr-board/hooks/status-check.ts"}
   ```

   That node path (from `command -v node`) is a temporary fnm shell path and will stop working. Use a stable Node 24 path instead (for example the fnm default alias, or whatever `fnm exec --using=24 which node` prints). The hook needs Node 24 because it runs the TypeScript directly.

4. **Install the skill.** `ln -s /Users/danyel/code/MISC/pr-board/skill/pr-status ~/.claude/skills/pr-status`
