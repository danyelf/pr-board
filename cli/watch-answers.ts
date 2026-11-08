// Waits for the owner's answers from the board on the items a Claude session handed over, claims them
// with a 👀 reaction, prints them and exits, which wakes the session. Run it in the background:
//   node cli/watch-answers.ts owner/repo#N [owner/repo#M ...]
// It costs nothing while it waits, and it never exits on a timer or because of errors, since every
// exit is a paid wake-up for the session.
import { claim, describe, waitingAnswers, type Found } from './answers.ts';
import { OwnerError, currentRepo, gh, readRef, refuseOwner } from './gh.ts';
import type { Deps as BaseDeps, Ref } from './gh.ts';
import { POLL_MS, backoff, message } from './poll.ts';

export interface Deps extends BaseDeps {
  sleep: (ms: number) => Promise<void>;
}

/** After the first answer, how long to wait for the rest, so one wake-up takes them all. */
const COLLECT_MS = 60_000;

export async function main(argv: string[], deps: Deps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const refs: Ref[] = [];
  // "#N" needs the current directory's repo, which is looked up in the loop so a passing failure is retried.
  const unresolved: number[] = [];
  try {
    if (argv.length === 0) throw new Error('Usage: watch-answers <owner/repo#N> [<owner/repo#N> ...]');
    for (const text of argv) {
      const ref = readRef(text);
      if ('owner' in ref) refs.push(ref);
      else unresolved.push(ref.n);
    }
  } catch (e) {
    err(message(e));
    return 1;
  }

  try {
    await refuseOwner(deps.gh, 'Answers picked up here would look as if nobody had. Run the watcher under Claude\'s account.');
  } catch (e) {
    if (e instanceof OwnerError) {
      err(e.message);
      return 1;
    }
    err(`Couldn't tell which account gh is signed in as (${message(e)}); watching anyway.`);
  }

  let failures = 0;
  for (;;) {
    try {
      if (unresolved.length > 0) {
        const repo = await currentRepo(deps.gh);
        refs.push(...unresolved.splice(0).map((n) => ({ ...repo, n })));
      }
      const first = await waitingAnswers(deps.gh, refs, out);
      if (refs.length === 0) {
        out('Every item it was watching is closed or merged; nothing left to watch.');
        return 0;
      }
      if (first.length > 0) {
        await deps.sleep(COLLECT_MS);
        const claimed: Found[] = [];
        for (const f of await waitingAnswers(deps.gh, refs, out)) {
          try {
            if (await claim(deps.gh, f)) claimed.push(f);
          } catch (e) {
            // Left unclaimed, so the next watcher will see it.
            err(`Couldn't claim ${f.url}: ${message(e)}`);
          }
        }
        if (claimed.length > 0) {
          out(`Picked up ${claimed.length === 1 ? 'one answer' : `${claimed.length} answers`} (each now has a 👀):`);
          for (const f of claimed) out(`\n${await describe(deps.gh, f)}`);
          return 0;
        }
      }
      failures = 0;
      await deps.sleep(POLL_MS);
    } catch (e) {
      failures++;
      const wait = backoff(POLL_MS, failures);
      err(`${new Date().toISOString()} ${message(e)}; trying again in ${wait / 1000} s`);
      await deps.sleep(wait);
    }
  }
}

if (import.meta.main) {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  process.exitCode = await main(process.argv.slice(2), { gh, sleep });
}
