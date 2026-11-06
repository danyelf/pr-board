# Questions for Danyel

Collected while building part 1 (a board you can read). Newest at the bottom. Each one says what I did in the meantime.

## Noticed along the way

1. **This Claude session isn't running as danyel-claude.** Your global instructions say my GitHub activity goes through the danyel-claude account via `GH_TOKEN`, but in this session `GH_TOKEN` is unset and `gh` is logged in as danyelf. I've only done reads on GitHub (no posts), so nothing went out under your name. Worth checking why the token didn't load here; the status helper relies on it to post as danyel-claude.
