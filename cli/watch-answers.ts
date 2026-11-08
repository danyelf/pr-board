// Waits for the owner's answers from the board on the items a Claude session handed over, claims them
// with a 👀 reaction, prints them and exits, which wakes the session. Run it in the background:
//   node cli/watch-answers.ts owner/repo#N [owner/repo#M ...]
// It costs nothing while it waits, and it never exits on a timer or because of errors, since every
// exit is a paid wake-up for the session.
import { LOOK_KEY, LOOK_QUESTION, parseAnswer, type Answer } from '../src/shared/answer.ts';
import { OWNER_LOGIN } from '../src/shared/config.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { parseStatus } from '../src/shared/status.ts';
import type { Status } from '../src/shared/types.ts';
import { flattenPages, gh, refString } from './gh.ts';
import type { Deps as BaseDeps, Gh, Ref } from './gh.ts';
import { parseRef, readStatusText } from './pr-status.ts';

export interface Deps extends BaseDeps {
  sleep: (ms: number) => Promise<void>;
}

export const POLL_MS = 60_000;
/** After the first answer, how long to wait for the rest, so one wake-up takes them all. */
export const COLLECT_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

interface RestComment { id: number; user: { login: string } | null; body: string; html_url: string; reactions?: { eyes?: number } }

/** An answer comment nobody has claimed yet. */
interface Found { ref: Ref; id: number; url: string; answer: Answer }

const base = (ref: Ref) => `repos/${ref.owner}/${ref.repo}`;

/** True when someone other than the owner has reacted 👀 to the comment. */
async function isClaimed(gh: Gh, ref: Ref, c: RestComment): Promise<boolean> {
  if (c.reactions?.eyes === 0) return false;
  const url = `${base(ref)}/issues/comments/${c.id}/reactions?content=eyes&per_page=100`;
  const reactions = flattenPages(await gh(['api', url, '--paginate', '--slurp'])) as { user: { login: string } | null }[];
  return reactions.some((r) => r.user !== null && r.user.login !== OWNER_LOGIN);
}

/** The owner's answers on these items that nobody has claimed, oldest first within each item. */
async function unclaimed(gh: Gh, refs: Ref[]): Promise<Found[]> {
  const found: Found[] = [];
  for (const ref of refs) {
    const url = `${base(ref)}/issues/${ref.n}/comments?per_page=100`;
    const comments = flattenPages(await gh(['api', url, '--paginate', '--slurp'])) as RestComment[];
    for (const c of comments) {
      if (c.user?.login !== OWNER_LOGIN) continue;
      const answer = parseAnswer(c.body);
      if (!answer || (await isClaimed(gh, ref, c))) continue;
      found.push({ ref, id: c.id, url: c.html_url, answer });
    }
  }
  return found;
}

/**
 * Adds this account's 👀 to the answer. GitHub says 201 when the reaction is new and 200 when this
 * account had already reacted, which means another session running as the same account claimed it first.
 */
async function claim(gh: Gh, f: Found): Promise<boolean> {
  const res = await gh(['api', '-X', 'POST', `${base(f.ref)}/issues/comments/${f.id}/reactions`, '-f', 'content=eyes', '--include']);
  return /^HTTP\/\S+\s+201\b/.test(res);
}

/** The answers in words, with whether they still answer the item's current questions. */
async function describe(gh: Gh, f: Found): Promise<string> {
  const lines = [`${refString(f.ref)}: ${f.url}`];
  let current: string | null = null;
  let status: Status | null = null;
  try {
    status = parseStatus(await readStatusText(gh, f.ref));
    current = statusFingerprint(status);
  } catch (e) {
    lines.push(`  Couldn't read the current status (${e instanceof Error ? e.message : String(e)}); check the fingerprint ${f.answer.fingerprint} by hand before applying these.`);
  }
  const matches = current === f.answer.fingerprint;
  if (current !== null) {
    lines.push(matches
      ? `  fingerprint ${f.answer.fingerprint} matches the current status`
      : `  fingerprint ${f.answer.fingerprint} does NOT match the current status (${current}): the questions changed after these answers were sent. Don't apply them; ask again.`);
  }
  for (const [key, value] of Object.entries(f.answer.answers)) {
    if (key === LOOK_KEY) continue;
    const q = matches ? status?.questions.find((x) => String(x.n) === key) : undefined;
    lines.push(q ? `  ${q.n}. ${q.text} → ${value}` : `  ${key} → ${value}`);
  }
  const look = f.answer.answers[LOOK_KEY];
  if (look) lines.push(`  ${LOOK_QUESTION} → ${look}`);
  if (f.answer.note) lines.push(`  Note: ${f.answer.note.split('\n').join('\n    ')}`);
  return lines.join('\n');
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const refs: Ref[] = [];
  try {
    if (argv.length === 0) throw new Error('Usage: watch-answers <owner/repo#N> [<owner/repo#N> ...]');
    for (const text of argv) refs.push(await parseRef(text, deps.gh));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }

  try {
    const me = (await deps.gh(['api', 'user', '-q', '.login'])).trim();
    if (me === OWNER_LOGIN) err(`Warning: running as ${me}, the board's owner. The board doesn't count the owner's own 👀 as a claim.`);
  } catch {
    // Only a warning hangs on this; the watching doesn't.
  }

  let failures = 0;
  for (;;) {
    try {
      if ((await unclaimed(deps.gh, refs)).length > 0) {
        await deps.sleep(COLLECT_MS);
        const claimed: Found[] = [];
        for (const f of await unclaimed(deps.gh, refs)) {
          try {
            if (await claim(deps.gh, f)) claimed.push(f);
          } catch (e) {
            // Left unclaimed, so the next watcher will see it.
            err(`Couldn't claim ${f.url}: ${e instanceof Error ? e.message : String(e)}`);
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
      const wait = Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
      err(`${new Date().toISOString()} ${e instanceof Error ? e.message : String(e)}; trying again in ${wait / 1000} s`);
      await deps.sleep(wait);
    }
  }
}

if (import.meta.main) {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  process.exitCode = await main(process.argv.slice(2), { gh, sleep });
}
