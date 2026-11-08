// Waits for the owner's answers from the board on the items a Claude session handed over, claims them
// with a 👀 reaction, prints them and exits, which wakes the session. Run it in the background:
//   node cli/watch-answers.ts owner/repo#N [owner/repo#M ...]
// It costs nothing while it waits, and it never exits on a timer or because of errors, since every
// exit is a paid wake-up for the session.
import { LOOK_KEY, LOOK_QUESTION, answersCurrentStatus, isWaitingAnswer, parseAnswer, type Answer, type CommentSeen } from '../src/shared/answer.ts';
import { OWNER_LOGIN } from '../src/shared/config.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { parseStatus } from '../src/shared/status.ts';
import type { Status } from '../src/shared/types.ts';
import { currentRepo, flattenPages, gh, readItem, readRef, readStatusText, refString } from './gh.ts';
import type { Deps as BaseDeps, Gh, ItemRead, Ref } from './gh.ts';

export interface Deps extends BaseDeps {
  sleep: (ms: number) => Promise<void>;
}

const POLL_MS = 60_000;
/** After the first answer, how long to wait for the rest, so one wake-up takes them all. */
const COLLECT_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface RestComment {
  id: number; user: { login: string } | null; body: string; html_url: string; created_at: string; updated_at: string;
  reactions?: { eyes?: number };
}

/** An answer comment nobody has claimed yet. */
export interface Found { ref: Ref; id: number; url: string; createdAt: string; answer: Answer }

const base = (ref: Ref) => `repos/${ref.owner}/${ref.repo}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A PR's description edits are only in the GraphQL API.
const PR_EDITED_QUERY = 'query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $n) { lastEditedAt createdAt } } }';

/**
 * When the item's status was written, so answers to an earlier status aren't taken for answers to
 * this one: the time pr-status recorded in it, else (for a section edited by hand, or one written
 * before that time was recorded) when the description or the status comment was last edited.
 */
async function statusWrittenAt(gh: Gh, ref: Ref, item: ItemRead<RestComment>): Promise<string | null> {
  const written = parseStatus(item.statusText)?.writtenAt;
  if (written) return written;
  if (!item.isPr) return item.statusComment?.updated_at ?? null;
  const at = await gh(['api', 'graphql', '-f', `query=${PR_EDITED_QUERY}`, '-f', `owner=${ref.owner}`, '-f', `repo=${ref.repo}`, '-F', `n=${ref.n}`,
    '-q', '.data.repository.pullRequest | .lastEditedAt // .createdAt']);
  return at.trim() || null;
}

/** The 👀 reactions on a comment. Skips the call when GitHub's count says there are none. */
async function eyesOn(gh: Gh, ref: Ref, c: RestComment): Promise<{ login: string | undefined; content: string }[]> {
  if (c.reactions?.eyes === 0) return [];
  const url = `${base(ref)}/issues/comments/${c.id}/reactions?content=eyes&per_page=100`;
  const reactions = flattenPages(await gh(['api', url, '--paginate', '--slurp'])) as { user: { login: string } | null; content?: string }[];
  return reactions.map((r) => ({ login: r.user?.login, content: r.content ?? 'eyes' }));
}

/**
 * Reads each item. Drops, saying so, the ones that are closed or merged, since no answer will come
 * for them. Returns the owner's answers still waiting on the rest, oldest first within each item.
 */
export async function waitingAnswers(gh: Gh, refs: Ref[], say: (line: string) => void): Promise<Found[]> {
  const found: Found[] = [];
  for (const ref of [...refs]) {
    const item = await readItem<RestComment>(gh, ref);
    if (!item.open) {
      refs.splice(refs.indexOf(ref), 1);
      say(`${refString(ref)} is closed or merged; no longer watching it.`);
      continue;
    }
    const writtenAt = await statusWrittenAt(gh, ref, item);
    for (const c of item.comments) {
      const seen: CommentSeen = { login: c.user?.login, body: c.body, createdAt: c.created_at };
      // Reactions are read only for the answers to the current status.
      if (!answersCurrentStatus(seen, writtenAt) || !isWaitingAnswer(seen, writtenAt, await eyesOn(gh, ref, c))) continue;
      found.push({ ref, id: c.id, url: c.html_url, createdAt: c.created_at, answer: parseAnswer(c.body)! });
    }
  }
  return found;
}

/**
 * Adds this account's 👀 to the answer. GitHub says 201 when the reaction is new and 200 when this
 * account had already reacted, which means another session running as the same account claimed it first.
 */
export async function claim(gh: Gh, f: Found): Promise<boolean> {
  const res = await gh(['api', '-X', 'POST', `${base(f.ref)}/issues/comments/${f.id}/reactions`, '-f', 'content=eyes', '--include']);
  return /^HTTP\/\S+\s+201\b/.test(res);
}

/** The answers in words, with whether they still answer the item's current questions. */
export async function describe(gh: Gh, f: Found): Promise<string> {
  const lines = [`${refString(f.ref)}: ${f.url}`];
  let current: string | null = null;
  let status: Status | null = null;
  try {
    status = parseStatus(await readStatusText(gh, f.ref));
    current = statusFingerprint(status);
  } catch (e) {
    lines.push(`  Couldn't read the current status (${message(e)}); check the fingerprint ${f.answer.fingerprint} by hand before applying these.`);
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

  let me: string | null = null;
  try {
    me = (await deps.gh(['api', 'user', '-q', '.login'])).trim();
  } catch (e) {
    err(`Couldn't tell which account gh is signed in as (${message(e)}); watching anyway.`);
  }
  if (me === OWNER_LOGIN) {
    err(`gh is signed in as ${me}, the board's owner. The board doesn't count the owner's own 👀 as a claim, so answers picked up here would look as if nobody had. Run the watcher under Claude's account.`);
    return 1;
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
      const wait = Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
      err(`${new Date().toISOString()} ${message(e)}; trying again in ${wait / 1000} s`);
      await deps.sleep(wait);
    }
  }
}

if (import.meta.main) {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  process.exitCode = await main(process.argv.slice(2), { gh, sleep });
}
