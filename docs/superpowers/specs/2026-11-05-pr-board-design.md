# PR Board: design

Date: 2026-11-05. Status: draft for review.

## Why this exists

Danyel works with Claude Code on several pull requests at once, across several repos (Torahmap is the busiest). Each piece of work moves through the same steps:

1. Discuss an idea and file an issue.
2. Pick an issue; brainstorm and design; open a PR.
3. Build in the PR.
4. Design-iterate on the PR (screenshots, mockups, Danyel's look at the preview).
5. Sometimes reset and rebuild the PR.
6. After Danyel approves, Claude rebases and self-reviews ("prep for merge").
7. Danyel merges (or Claude rebases first and then he merges).

Along the way Claude asks Danyel for decisions, mostly at steps 1, 2 and 4, and on whether to push ahead with something big.

The problem: the state of each PR lives in chat scrollback. When something urgent comes in, the other PRs scroll out of sight, and Danyel has to ask "what's the state of 573?" or "what questions do I have to answer?". On 2026-11-05, for example:

- #573 and #574 had been reviewed by Claude and were waiting on Danyel's look for 1 day 16 hours. Nothing in the terminal said so.
- #564 had been waiting on Danyel for three days for a look at the preview and an answer about a colour tint. That ask existed only as the last message of a separate session. Its issue carried only the `in-progress` label, which said it had been picked up but not that it was waiting on Danyel.

### Goals

- Stop Danyel having to ask for the state of a PR or for his open questions.
- Show what work and which decisions are waiting on him, and for how long.
- Let him answer a question by clicking into the PR on a page, rather than typing "574: Q1 fix it" into a terminal.
- Show how many things are running at once, alongside his own activity.
- Keep the screenshots, design docs and preview links for each PR within reach.
- Work from the laptop (main use) and the phone.

### Non-goals

- A general product for other people. This is Danyel's tool, across his repos.
- Replacing Claude Code's Agent View or Remote Control. Those are organised around sessions; this is organised around PRs.
- A terminal app. Danyel doesn't like them (that rules out Claude Squad-style tools).
- Per-repo stage names. One fixed set for now.

### Anti-goals (failure even if it works)

- The page says something is fine when it is actually waiting on Danyel. Stale or wrong state is worse than no page.
- The page lectures him about his own absence, for example by showing a big empty day because he was away.
- The tool burns tokens while nothing is happening.
- Everything breaks when Claude Code upgrades. GitHub holds the state; everything else must be cheap to throw away and rebuild.

## Prior art (researched 2026-11-05)

- **Claude Code Agent View** (`claude agents`) groups sessions by Needs input / Working / Ready for review, and you can reply from it. It is per session, and Danyel mostly works in one long-running main session that handles 6–7 PRs, so it shows little.
- **Remote Control** lets claude.ai/code or the phone reply into a running local session. There is no public API for a custom page to send into it.
- **Conductor**, **Nimbalyst** (formerly Crystal), **Vibe Kanban** and others: none tracks per-PR stage, pending decisions, test protocol or timeline for existing CLI sessions.
- Danyel's own earlier tools: `~/code/MISC/26-02-claudemon` (a terminal dashboard of sessions fed by hooks) and `~/code/MISC/claude-ui` (an Electron app that captures clicks on UI elements). Neither is organised by PR.

## The core idea

**The PR is what we track, and GitHub holds its state.** The issue stands in until a PR exists. Claude writes down whose turn it is and what the ask is, on GitHub, every time it hands work back. The page reads GitHub. Everything that isn't on GitHub (the page, the hooks, the activity history) is disposable.

## What lives where

| What | Where |
|---|---|
| Whose turn it is | A GitHub label on the live item (issue before a PR exists, then the PR) |
| History of whose turn it was | GitHub's issue/PR timeline events for label added/removed |
| The ask, the questions, the test protocol | A status section at the top of the PR description; before a PR exists, one comment on the issue that Claude keeps editing |
| Danyel's answers | Comments on the PR (or issue), posted from his account, danyelf |
| Reviews, commits, merges, checks | GitHub, as today |
| Danyel's activity (times and PR numbers only) | Cloudflare D1, the only state the app owns. Rebuildable from the Mac. |
| Where the last activity upload stopped | A small marker file on the Mac |

### Turn labels

- `in-progress` (existing, unchanged): the item has been picked up, by Claude or anyone else. Danyel finds this useful as-is.
- `on danyel` (new): it's Danyel's turn. A look, an answer, or a merge.
- `parked` (new): waiting on something outside the two of them (for example #411, waiting on a licence question).

Whose turn it is: `on danyel` means Danyel's; `parked` means nobody's; otherwise, if it's `in-progress`, it's whoever picked it up. When Claude hands an item back it adds `on danyel`; Claude removes it when it picks up his answers (see "Settled for answering"). Created in every repo the tool covers.

The existing `review pending` label keeps its current meaning. Priority and map labels are untouched.

The stage is **not** a label. The page infers it (see below).

### The status section

At the top of the PR description, between markers, so it can be found and replaced by a program:

```
<!-- status -->
**Waiting on:** Danyel, since 2026-11-02T16:40:00-08:00
**Ask:** look at the preview, and answer one question
**Questions:**
1. Does the tint over the code dull the colours enough to change the shell?  (**leave** | change)
**To test:** pin a verse, leave the mouse on it, press Escape: the popup stays up, unpinned.
<!-- /status -->
```

- Questions are numbered and each lists its choices, so the page can draw buttons. A question with no listed choices gets a text box only.
- **Every question has a default**, the choice Claude would go with (bold above). The page makes the default visibly stand out, for example `Button colour: [[RED]] [green] [file an issue]`.
- **Every question also gets a "file an issue" choice.** It means "go with the default, and file the question as a new issue to decide later". Claude applies the default on the PR, files an issue holding the question, its choices, any screenshots and a link back to the PR, and marks the question on the PR "default taken; moved to #NNN". The PR stops waiting on that question. No work starts on the new issue.
- The page always offers a free-text "note back" as well.
- On issues with no PR yet, the same block goes in a single Claude comment on the issue, edited in place. Claude does not rewrite Danyel's own issue text.
- Merge commits in Torahmap use the PR title only (checked: `merge_commit_message: PR_TITLE`), so the status section doesn't leak into git history. Check this per repo.

The exact field set (for example, whether "To test" moves here from the existing "To look at on the preview:" paragraph or is read from there) is left to the builder, as long as the page can show all of it.

### Stage, inferred

One fixed set of stage names, in the order the work happens: **Issue · Design · Build · Your look · Prep · Ready for merge**.

Danyel has two turns. The first is **Your look**: he tries the PR and answers its questions, and if it's right he says "looks good, prep for merge". Claude then runs **Prep**, a careful review that also rebases and fixes what it finds. The second turn is **Ready for merge**: Danyel goes to the PR on GitHub, approves it and merges it. Claude never merges.

The facts to read:

- Issue exists; PR exists; linked by `Closes #N` / `Refs #N`.
- Design: a design doc in the PR (for example under `docs/plans/` or `docs/superpowers/specs/`), or mockups in the description.
- Build: the PR exists. A code review Claude posted before Prep (a `danyel-claude` comment beginning `Reviewed up to \`<sha>\``) shows as a note on Build, "✓ reviewed", with "N commits since" when there are commits after that sha.
- Your look: the turn label is `on danyel` and the ask is a look or questions. Done once Prep has run, because Prep only runs after Danyel's go-ahead.
- Prep: a `🤖 Claude: prep for merge` comment, with "N commits since" when there are commits after it.
- Ready for merge: ready when Prep is done with nothing since and GitHub says it can merge; blocked with a reason ("after #573" when the PR body says it is stacked on another, "rebase first" when behind main, "checks failing", and so on); done once merged.

## Keeping the record honest: the status hook

A Claude Code `Stop` hook on the Mac. When Claude finishes a turn in which it pushed to a PR's branch, commented on a PR or issue, or opened one, the hook checks that the status section and turn label on that item were updated during the turn. If not, it blocks the stop with a message telling Claude to update them.

- Which items a turn touched is found from the commands Claude ran (`gh pr …`, `gh issue …`, `git push`). This is the most fragile piece. If it misses, the result is a stale card, not a broken system.
- Claude's working instructions (global `CLAUDE.md` or a skill) should also say to keep the status section and label current; the hook is the check, not the only reminder.

## Answers getting back to Claude

**The look is itself a question.** Every card at the Your look stage asks it, after any questions Claude wrote, even when Claude wrote none:

> How does it look? (**looks good, prep for merge** | needs changes | file an issue)

Every Your look card also has a free-text note box, so "the tint is too strong, otherwise good" has somewhere to go on a card with no questions. "Looks good, prep for merge" is what moves the PR from Your look to Prep. "Needs changes" sends the note back to Claude and the PR stays before Prep. Because the answer is posted as a comment, the board can show that the look happened, rather than guessing it from Prep having run.

1. Danyel clicks choices on a card and presses **Send answers** (or types a note). The Worker posts one comment from danyelf on the PR, in a form a program can read, plus the note. (Built differently from first planned: the Worker leaves the `on danyel` label alone; see "Settled for answering".)
2. **Whichever Claude session is open picks it up.** A session that hands a PR to Danyel starts a background watcher script. It checks GitHub about once a minute for new answer comments not yet picked up. It exits only when it finds one, and waits about a minute after the first new answer to collect the rest. Exiting wakes the session (Claude Code re-invokes a session when its background command finishes). Claude acts on the answers, then restarts the watcher.
   - The watcher costs no tokens while it waits. It must never exit on a timer or a repeated error, because each exit is a paid wake-up.
   - Only one session may pick up a given answer. The builder decides how it is claimed (for example, an acknowledgement comment or reaction on the answer).
3. **If nobody picks it up**, the always-on service on the Mac (below) starts a fresh session in that PR's worktree with `claude -p "<the answers>"`. A fresh session has no chat memory, so it relies on the status section. The builder picks the grace period before this happens; a few minutes is the intent.

## Danyel's activity

- The timeline shows when Danyel was typing to Claude, and a mark on a PR's row whenever he said something about it.
- Source: Claude Code session history on the Mac (`~/.claude/projects/**.jsonl`). Only Danyel's own typed messages count, not tool output or messages from subagents. A message is linked to a PR by the numbers in it (`576:`, `#576`, `merged 576`) and, where clear, by branch names. Some messages will not link to anything; that's fine.
- **Sent in batches, only when there's something new.** The always-on service watches the history folder for changes. When something changes it uploads new records at most once every 10 minutes. Nothing is sent while Danyel is away.
- Only the time, session ID and PR numbers (with repo) leave the Mac, never message text.
- The first run backfills a few weeks so the timeline has history.
- The session history format is internal to Claude Code and may change. This row is allowed to break; the rest of the page must work without it.

## The page

Hosted on Cloudflare as a Worker, behind Cloudflare Access with Danyel's Google login. It reads GitHub directly, so it works from the laptop or phone with the Mac off (except the activity row going stale and fresh sessions not starting).

Repos covered: every repo the GitHub token Danyel provides can see. No list to maintain; the token decides.

Top to bottom:

1. **Waiting on you**, oldest wait first. One card per item:
   - number, title, a short "why" tag (`Needs your look`, `2 decisions + your look`, `Ready to merge`), how long it has waited
   - the stage strip, with the box that needs Danyel lit in amber (green when it's ready to merge)
   - links: Preview, PR, Claude's review, Issue, and Merge on GitHub when ready
   - the test protocol
   - each question with buttons for its choices, then the look question (looks good, prep for merge · needs changes · file an issue), a free-text note box, and **Send answers**
   - files: screenshots in the PR description (as thumbnails) and design docs the PR adds
   - At the very top of the page, a **File an issue** button: title, a few lines, optional screenshot (the phone matters here). It only files the issue; no work starts.
2. **On Claude**: items Claude is working on (a compact row each; not in the mockups yet, the builder decides the look).
3. **Quiet**: `parked` items and anything with no activity for a few days, one row each, saying what it's waiting on.
4. **Backlog**: open issues nobody has picked up, by priority, each with a **Pick up** button. Shown next to the "how many open at once" count so Danyel decides with his parallelism in view. Pick up adds `in-progress`, and the Mac service starts a **fresh Claude session for that issue, in a new worktree, with Remote Control on** (so it appears in claude.ai/code and on the phone; Danyel finds starting several Remote Control sessions by hand annoying). The session starts on step 2 (brainstorm and design), so it soon comes back to the top with its first questions.
5. **Timeline**: one row per PR open in the window, plus a **You** row on top.
   - Bars: blue when Claude is working (`in-progress` without `on danyel`), amber when waiting on Danyel, green when ready to merge, grey hatched when parked or quiet, grey for quick merged ones. Use label history for these; fall back to open→merged where there's no history.
   - Dots on a PR's row where Danyel said something about it.
   - **Real clock time**, except that any gap of 24 hours or more with no activity is cut down to a narrow break mark. A bar crossing a cut gap carries its true length as a label ("waited 1 d 16 h").
   - A "how many open at once" strip under the rows.
   - Times in Pacific time.

The mockups from this conversation (`docs/mockups/board-v3.html` and `board-v3.png`: cards with stage strip, quiet rows, timeline A) show the intended look. Timeline B (away time squeezed out) was rejected in favour of real time with the 24-hour cut.

## The always-on service on the Mac

One small background service started with the Mac at login. It does three jobs:

- Uploads Danyel's activity to the Worker (above).
- Starts a fresh Claude session for answers nobody picked up (above).
- Starts a fresh Claude session, with Remote Control on, for each issue Danyel picks up from the page. It learns about pick-ups the same way it learns about unclaimed answers (from GitHub, or from the Worker).

## Decided by Danyel

- The PR is the thing tracked, not the session.
- Claude writes the state down on GitHub; a hook checks it did.
- Turn labels are welcome (more labels are fine).
- Covers every repo where Claude opens PRs for him.
- One fixed set of stage names for now.
- Real clock time, with gaps of 24 hours or more cut out.
- Answers reach whichever session is open within about a minute via a background watcher; otherwise a fresh session starts.
- Hosted on Cloudflare so it works on the phone; the laptop is the main use.
- Activity uploads batch every 10 minutes at most, and only when there's something new.
- Every question shows its default visibly; "file an issue" means "take the default and file the question".
- The page can file an issue (sudden, out-of-band ideas) and pick up an issue (start the next project).
- If an answer isn't picked up within 10 minutes, the card goes back to the top and says so.
- Picking up an issue starts a fresh session with Remote Control on (Claude recommended; Danyel agreed).
- Code lives in `~/code/MISC/pr-board`.
- `in-progress` stays, meaning "picked up" by anyone.
- The page covers every repo the token he provides can see; the token type doesn't change the design.

## Claude's calls (not yet confirmed by Danyel)

- Two new labels, `on danyel` and `parked`, alongside the existing `in-progress`.
- Status section at the top of the PR description, not a comment stream; on issues, one comment edited in place.
- No stage labels; stage is inferred.
- Cloudflare Access with Google login; Danyel's answers posted as danyelf via a token stored as a Worker secret; Claude's own posts stay as danyel-claude.
- D1 for activity.
- Repos found by searching for the turn labels.

## Details settled after the builder review (Claude's calls)

- **The page only links to merge.** "Merge on GitHub" is a link. The page never merges.
- **Answers nobody has picked up are shown as such.** When a session picks up an answer it adds a reaction (👀) to the answer comment; that is the claim. If an answer has no claim after 10 minutes, the card moves back to the top section as "Answered, not picked up", so the page never claims Claude is working when nothing is. The Mac service sends the Worker a heartbeat every 10 minutes while the Mac is awake; if the heartbeat is older than 30 minutes, the page shows a small "Mac offline: answers will wait" note.
- **Each watcher watches only what its own session handed back.** A session records the items it labelled `on danyel` and watches only those. The always-on service is the only thing that watches everything, and only for answers still unclaimed after its grace period (5 minutes).
- **Finding the worktree for a fresh session.** The Mac service has a small config file mapping each repo to its local clone. It finds the PR's worktree by branch name in `git worktree list`. If none exists, it creates one under the repo's `.claude/worktrees/<branch>`, the existing convention.
- **How the hook knows the status was updated.** At the end of a turn that touched an item, the hook compares the item's description `updatedAt` and its latest label event with the turn's start time. Claude may leave the status unchanged on purpose by running a small helper command that records "status checked, still correct" for that item, so the hook doesn't block a turn that legitimately changed nothing about the ask.
- **Answers to out-of-date questions.** Each answer comment carries a short fingerprint of the status section it answered. If Claude has changed the questions since, the session sees the mismatch and asks again rather than applying answers to the wrong numbers.
- **The review conventions already exist.** `Reviewed up to \`<sha>\`` and `🤖 Claude: prep for merge` come from the global `prep-for-merge` skill (`~/.claude/skills/prep-for-merge/SKILL.md`), so they apply in every repo. Design docs are recognised as `.md` files the PR adds under `docs/`.
- **Starting labels.** A one-off pass where Claude reads each open item and its last session and proposes which ones get `on danyel` or `parked`. Danyel approves the list before any label changes (for example, #564 would get `on danyel`).
- **Which repos.** Whatever the token sees (Danyel decided). Today that is mainly `danyelf/torahmap` and `danyelf/danyelfisher.info`.

## Settled for answering (Claude's calls, for Danyel to confirm)

Decided on 2026-11-08 while building answering, with nobody awake to ask. Each is a call Danyel can overturn. They replace the two open questions from the review of part 1 (two records of whose turn it is; the status as data as well as text).

- **The Worker never changes whose turn it is.** It posts the answer and nothing else: no label change, no edit to the status section. The board works out "answered" from an answer comment by `ownerLogin` newer than the status, and moves the card to "On Claude" until a session claims it with 👀; with no claim after 10 minutes it comes back to the top as "Answered, not picked up". Once Claude rewrites the status, the answer is older than it and the card follows the labels again. Reasons: whose turn it is keeps one writer, Claude, so an answer can't leave the label and the status disagreeing. And the label is how answered items are found: the board fetches issues by label, and the Mac service looks for answers only on items labelled `on danyel`, so taking the label off at answer time would hide the very items that still need Claude. The label means "the last status Claude wrote says it's Danyel's turn", which stays true until Claude acts on the answer.
- **The status as data too, trusted only while the text agrees.** `pr-status set` also writes the status as a hidden data line inside the markers, with a fingerprint of what it asks and the time it was written. The board uses the data only while the visible lines are exactly what it would render; after a hand edit it reads the text and tags the card "status edited by hand". Reason: the data survives odd characters, and its write time tells answers to this status from older ones; a hand edit is shown as written, never silently overruled. The fingerprint is a short non-cryptographic hash, since it only has to notice changed questions.
- **The look question.** Every PR at Your look asks "How does it look?" after Claude's questions, with "looks good, prep for merge" as the default. Reason: it is the one question every PR has, so Claude doesn't have to write it each time. Choices are radio buttons, so the page needs no script.
- **One answer comment, in one shared format.** The answers go up as one comment from Danyel's account: a line for programs, then the same answers for people. `src/shared/answer.ts` holds the format and the rules for an answer that is still waiting, and both the Worker and the watcher use it. Reason: GitHub stays the only record, and the two sides can't drift apart.
- **One token to read and to post.** `GITHUB_TOKEN`, from Danyel's account, with write access to issues and pull requests. If GitHub refuses the comment (403 or 404), the page says the token needs that access. Reason: a second token would sit beside the first in the same Worker's secrets, so it would add a secret to renew without making a leak any smaller, and the reading code never calls anything that writes. The Worker checks the comment went up as `ownerLogin`, because the watcher reads only that account's answers.
- **POST /answer refuses rather than guesses.** Same Access check as the page, and only from the page's own origin. It reads the item again and refuses when it is closed, already answered since its status, no longer Danyel's turn, or asking different questions from the page that sent the answers. Reason: answers must never land on changed questions, or go up twice.
- **The watcher.** Started by the session that handed the items over. It waits for answers to the current status, claims them with 👀, prints them and exits; it never exits on a timer or an error, and refuses to start under Danyel's own account. Reason: every exit is a paid wake-up for the session, and the board doesn't count Danyel's own 👀 as a claim.
- **Reading claims without a bigger query.** Only the answers since each status get a second, small query for their 👀. If it fails, they count as not picked up. Reason: the main query stays its size, and a failure errs toward showing an answer as still waiting.

## Settled for the Mac service (Claude's calls, for Danyel to confirm)

Decided on 2026-11-08 while building `cli/mac-service.ts`, with nobody awake to ask.

- **It acts as Claude's account throughout.** Its own GitHub calls, the 👀 claim among them, and the sessions it starts all use the token in `~/.config/claude-github/token`, as the `claude` shell function does in a repo marked `claude.bot=true`. Reason: under launchd, `gh` would otherwise use the account it is logged in as on this Mac, which is danyelf, and the board doesn't count the owner's 👀 as a claim. Like the watcher, it refuses to start if it would run as the owner.
- **Everything that can fail comes before the claim.** It claims an answer only after checking the repo is marked `claude.bot=true`, the token file has a token, the worktree is there (or has been created), the answers are written into the prompt and the log folder exists; and, right before the claim, that the token isn't the owner's. If any of that fails it logs why and leaves the answer unclaimed, so an open session or a later poll can still take it. A repo not marked is refused outright, since the session would act as danyelf. With no token the service's GitHub calls refuse; they never fall back to whichever account `gh` is logged in as.
- **A claim is given back if the session can't start.** It keeps the id of its 👀 from the claim's reply. If the process fails to start, it deletes that reaction and logs it, and says "Started a session" only once the process has really started.
- **A claim is given back if the session does nothing with it.** When a session ends, it reads the item again. If the status wasn't rewritten after the answer (the rule the board uses for "an answer to the current status", in `src/shared/answer.ts`), it deletes its 👀 so the card says "Answered, not picked up" again, logs where the session's output is, and remembers that answer so it never takes it a second time. There is no automatic retry: a session that failed once on an answer would likely fail again, and the board is how Danyel finds out.
- **Time limit.** A session still running after `sessionMinutes` (60 by default) is stopped by signalling its whole process group (sessions are started detached, so their children go with them); the check above then runs as for any ended session.
- **A state file, so a restart loses nothing.** `~/.pr-board/state.json` (the `stateDir` setting), one JSON file rewritten whole, holds each running session's process id, item, answer comment ids, reaction ids, start time and log path, and the answers it has given back. On startup it reloads the file, counts the sessions still running against `maxSessions`, and runs the check above for those whose process is gone.
- **The watcher's own code.** It finds waiting answers, claims them and prints them with the same functions as `cli/watch-answers.ts` (in `cli/answers.ts`), so the rule for a waiting answer and the printed form have one definition. It looks only at open items carrying `on danyel`, and reads no further into one with no comments.
- **One session per item, all its answers together.** When any answer on an item is past the grace period, every waiting answer on it goes into one session. While that session runs, the item is left alone. At most two sessions run at once (a setting); an item over the limit waits for a later poll, still unclaimed.
- **Where the session runs.** A PR's worktree is found by its branch in `git worktree list`; if none has it, one is made under the clone's `.claude/worktrees/<branch>` after a fetch, from the local branch if there is one and from the remote's otherwise. An issue on Danyel's turn is taken to have no PR (the skill moves the status to the PR once there is one), so it gets `.claude/worktrees/issue-<n>` on a new branch `issue-<n>` (not tracking the default branch) from the default branch, or the worktree already on that branch. Dependencies are not installed in a new worktree; the session is told to install them.
- **Worktrees it refuses.** Never the main checkout (the first entry of `git worktree list`), never one git marks `prunable`, never a path that isn't a directory. For a PR it refuses unless the PR's branch lives in the repo itself (a fork's branch is refused) and its name doesn't start with `-`; git commands put `--` before their paths and names. A refused item is logged and the answer left unclaimed.
- **What the session is told.** The answers exactly as the watcher prints them (with whether each fingerprint matches), the item and the worktree, to follow the skill's "Answers from the board", not to start the watcher (a `claude -p` session ends when it finishes), and that the worktree may be new, so install dependencies before running tests. The rest (no chat memory, read the item, act, end with `pr-status set`) is in the skill.
- **Dry run changes nothing.** `--dry-run` also skips fetching and creating worktrees (it says which it would create), so it can be tried on the real repos safely.
- **Stopping.** It never stops because of errors; a repo that fails is logged and retried with the watcher's back-off, and the others carry on. One item that can't be read is logged and skipped, and counts toward the back-off, without holding up the rest of its repo. A clone that isn't a directory, or a repo not marked `claude.bot`, is logged once at startup and left out. It stops on SIGTERM or SIGINT and leaves its sessions running (the launchd agent sets `AbandonProcessGroup` so launchd doesn't kill them either); the state file lets the next run pick them up again.

## Next parts

Done: **the always-on Mac service** starts a fresh Claude session for answers nobody picked up, after its 5-minute grace period and before the board's 10 (`cli/mac-service.ts`, with a launchd agent in `mac/`; installing it is README step 9).

Left for later, in no fixed order:

- **The Mac service's heartbeat**, and the page's "Mac offline: answers will wait" note.
- **File an issue** at the top of the page, and **Pick up** on backlog issues (the Mac service starts the session for a pick-up).
- **Activity upload and the timeline.**

## Left to the builder

- Languages and frameworks for the Worker, the page, the hook and the Mac service (Cloudflare Workers + D1 are fixed).
- Caching of GitHub reads, within GitHub's rate limits.
- The exact answer-comment format and how a session claims an answer.
- How "commits since review" is judged.
- The look of the "On Claude" section and the phone layout.
