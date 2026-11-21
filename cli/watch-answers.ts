// Waits for the owner's answers from the board on the items a Claude session handed over, claims them
// there, prints them and exits, which wakes the session. Run it in the background:
//   node cli/watch-answers.ts owner/repo#N [owner/repo#M ...]
// It costs nothing while it waits, and it never exits on a timer or because of errors, since every
// exit is a paid wake-up for the session.
import { BoardError, boardCall, realBoardDeps, where, workPath, type BoardDeps } from './board.ts';
import { describe } from './answers.ts';
import { OwnerError, currentRepo, gh, readRef, refString, refuseOwner } from './gh.ts';
import type { Deps as BaseDeps, Ref } from './gh.ts';
import { message } from '../src/shared/helpers.ts';
import { POLL_MS, backoff } from './poll.ts';
import { Refused, type Found } from '../src/shared/work.ts';

export interface Deps extends BaseDeps {
  board: BoardDeps;
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
    await refuseOwner(deps.gh, 'The review request would then look as if nobody had asked. Run the watcher under Claude\'s account.');
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
      const waiting = await boardCall<Found[]>(deps.board, 'POST', '/api/unclaimed', { refs: refs.map(where) });
      if (waiting.length > 0) {
        await deps.sleep(COLLECT_MS);
        const claimed: Found[] = [];
        // Every watched item is claimed, since more may have come in during the wait; one with nothing left comes back empty.
        for (const ref of [...refs]) {
          try {
            const got = await boardCall<Found>(deps.board, 'POST', '/api/claim', { ...where(ref), by: 'session' });
            if (got.answers.length > 0) claimed.push(got);
          } catch (e) {
            if (e instanceof Refused) {
              // The board refuses a claim on an item that has ended; there is nothing to claim, and no answer will come.
              refs.splice(refs.indexOf(ref), 1);
              out(`${refString(ref)} has ended on the board (${e.message}); no longer watching it.`);
              continue;
            }
            if (!(e instanceof BoardError)) throw e;
            // Left unclaimed, so the next check sees it.
            err(`Couldn't claim ${refString(ref)}: ${e.message}`);
          }
        }
        if (claimed.length > 0) {
          out(`Picked up ${claimed.length === 1 ? 'one answer' : `${claimed.length} answers`}:`);
          for (const c of claimed) out(`\n${describe(c.record, c.answers)}`);
          return 0;
        }
      } else {
        // Nothing waiting: drop the items whose record has ended, since no answer will come for them.
        for (const ref of [...refs]) {
          try {
            await boardCall(deps.board, 'GET', workPath(ref));
          } catch (e) {
            if (!(e instanceof BoardError) || e.status !== 404) throw e;
            refs.splice(refs.indexOf(ref), 1);
            out(`${refString(ref)} has ended on the board; no longer watching it.`);
          }
        }
        if (refs.length === 0) {
          out('Every item it was watching has ended; nothing left to watch.');
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
  process.exitCode = await main(process.argv.slice(2), { gh, board: realBoardDeps(), sleep });
}
