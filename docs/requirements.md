# PR Board: what it is for

## The problem

Danyel works with Claude Code on several pull requests at once, across several repos. Each piece of work goes through the same steps: design it, build it, prepare it for merge, merge it. At each step Claude may need something from Danyel: an approval, an answer to a question, a look at the result.

Without the board, where each piece of work stands lives in chat scrollback. When something urgent comes in, the rest scrolls out of sight, and Danyel has to ask "what's the state of 573?" or "what questions do I owe you?". Work has sat waiting on him for days with nothing saying so.

## Who uses it

Only Danyel, mostly on his laptop, sometimes on his phone. Claude keeps the information on it up to date; Danyel reads it and answers from it.

## What he needs to do with it

- **See what is waiting on him**, and how long it has waited, without asking.
- **See at a glance where each piece of work stands**: which step it is at (design, build, prep for merge), and whether it is his turn or Claude's.
- **See at a glance what is ready to merge**, and trust it: "ready" means it really can be merged now.
- **Answer from the page**: approve a step, pick a choice on each of Claude's questions, or say what needs changing.
- **Send Claude a note at any time**, also while Claude is working.
- **Reach what he needs to judge the work**: the preview, the PR, the issue, screenshots.
- **See that his answer was sent and picked up**, or that nobody picked it up.

## What would make it a failure, even if it works

- It shows something as fine, or as Claude's turn, when it is actually waiting on him. Stale or wrong is worse than no page.
- It shows "ready to merge" when the merge would be refused.
- It makes him read more than he needs to: the same thing said twice, long phrases where a word would do, decoration that means nothing.
- A colour means different things in different places, so he can't read a card by its colour.
- It lectures him, or fills space with things he didn't ask for.

## Not its job

- Being a product for anyone else.
- Replacing Claude Code's own session views; this is organised around pieces of work, not sessions.
- Merging. Danyel merges, on GitHub.
- Work that isn't about one PR or issue (questions, investigations); that stays in chat.
