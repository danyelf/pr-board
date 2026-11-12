import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OWNER_LOGIN } from '../src/shared/config.ts';
import { LABEL_ON_OWNER, LABEL_PARKED, WAITING_ON, type WaitingOn } from '../src/shared/names.ts';
import { STATUS_CLOSE, STATUS_OPEN, parseStatus, pickStatusComment, renderStatus, replaceStatus, statusValueProblem } from '../src/shared/status.ts';
import type { Question, Status } from '../src/shared/types.ts';
import { gh, isNotFound, issueComments, parseRef, readStatusText, refString } from './gh.ts';
import type { Deps as BaseDeps, Gh, Ref } from './gh.ts';

export interface Deps extends BaseDeps {
  now: () => Date;
  /** The home folder, where the list of "status is still right" notes is kept. */
  home: string;
}

interface SetOptions {
  waiting: WaitingOn;
  ask: string;
  questions: string[];
  toTest: string | null;
}

function parseSetArgs(args: string[]): SetOptions {
  const opts: SetOptions = { waiting: 'nobody', ask: '', questions: [], toTest: null };
  let waiting: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const value = args[i + 1];
    const need = (): string => {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i++;
      // The status section keeps each field on one line; anything more would be cut off or misread.
      const problem = statusValueProblem(value);
      if (problem === 'line break') {
        throw new Error(`${flag} must be one line; join the steps with "; " or "1) … 2) …" instead of line breaks`);
      }
      if (problem === 'status marker') throw new Error(`${flag} can't contain a status marker`);
      return value;
    };
    if (flag === '--waiting') waiting = need();
    else if (flag === '--ask') opts.ask = need();
    else if (flag === '--question') opts.questions.push(need());
    else if (flag === '--to-test') opts.toTest = need();
    else throw new Error(`Unknown option ${flag}`);
  }
  const roles: readonly string[] = WAITING_ON.map((w) => w.role);
  if (waiting === null || !roles.includes(waiting)) {
    throw new Error(`--waiting must be ${roles.slice(0, -1).join(', ')} or ${roles.at(-1)}`);
  }
  opts.waiting = waiting as WaitingOn;
  return opts;
}

/** Parses "text (**a** | b)" through the shared status parser so the format has one definition. */
function buildQuestions(texts: string[]): Question[] {
  const section = [STATUS_OPEN, '**Waiting on:** nobody', '**Questions:**', ...texts.map((t, i) => `${i + 1}. ${t}`), STATUS_CLOSE].join('\n');
  const parsed = parseStatus(section);
  const questions = parsed?.questions ?? [];
  for (const q of questions) {
    if (q.defaultChoice === null) {
      throw new Error(`Question ${q.n} has no bold default. Give every question choices with one in bold, like "Colour? (**red** | green)".`);
    }
  }
  return questions;
}

function nextStatus(opts: SetOptions, questions: Question[], previous: Status | null, now: Date): Status {
  const since = previous && previous.waitingOn === opts.waiting && previous.since ? previous.since : now.toISOString();
  return { waitingOn: opts.waiting, since, ask: opts.ask, questions, toTest: opts.toTest, writtenAt: now.toISOString() };
}

/** A PR that has just been handed to the owner, and who opened it; null otherwise. */
type HandedOver = { author: string | null } | null;

async function writeStatus(gh: Gh, ref: Ref, opts: SetOptions, questions: Question[], now: Date): Promise<HandedOver> {
  const base = `repos/${ref.owner}/${ref.repo}`;
  const item = JSON.parse(await gh(['api', `${base}/issues/${ref.n}`])) as {
    pull_request?: unknown;
    body?: string | null;
    user?: { login: string } | null;
  };
  if (item.pull_request) {
    const body = item.body ?? '';
    const previous = parseStatus(body);
    const status = nextStatus(opts, questions, previous, now);
    await gh(['api', '-X', 'PATCH', `${base}/pulls/${ref.n}`, '-f', `body=${replaceStatus(body, status)}`]);
    const handedOver = opts.waiting === 'owner' && previous?.waitingOn !== status.waitingOn;
    return handedOver ? { author: item.user?.login ?? null } : null;
  }
  const login = (await gh(['api', 'user', '-q', '.login'])).trim();
  const comments = await issueComments<{ id: number; body: string; user: { login: string } | null }>(gh, ref);
  // The board reads the last status comment. Edit it if it is ours; otherwise a new one becomes the last.
  const current = pickStatusComment(comments);
  const status = nextStatus(opts, questions, current ? parseStatus(current.body) : null, now);
  if (current && current.user?.login === login) {
    await gh(['api', '-X', 'PATCH', `${base}/issues/comments/${current.id}`, '-f', `body=${replaceStatus(current.body, status)}`]);
  } else {
    await gh(['api', '-X', 'POST', `${base}/issues/${ref.n}/comments`, '-f', `body=${renderStatus(status)}`]);
  }
  return null;
}

/** Asks the board's owner to review, so GitHub notifies them. Returns what went wrong, or null. */
async function requestReview(gh: Gh, ref: Ref, author: string | null): Promise<string | null> {
  if (author === OWNER_LOGIN) return null; // GitHub won't ask someone to review their own PR.
  try {
    await gh(['api', '-X', 'POST', `repos/${ref.owner}/${ref.repo}/pulls/${ref.n}/requested_reviewers`, '-f', `reviewers[]=${OWNER_LOGIN}`]);
    return null;
  } catch (e) {
    return `Couldn't ask ${OWNER_LOGIN} to review ${refString(ref)}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Returns the names of labels that were wanted but don't exist in the repo. */
async function syncLabels(gh: Gh, ref: Ref, waiting: SetOptions['waiting']): Promise<string[]> {
  const base = `repos/${ref.owner}/${ref.repo}`;
  const add = waiting === 'owner' ? [LABEL_ON_OWNER] : waiting === 'nobody' ? [LABEL_PARKED] : [];
  const remove = waiting === 'owner' ? [LABEL_PARKED] : waiting === 'nobody' ? [LABEL_ON_OWNER] : [LABEL_ON_OWNER, LABEL_PARKED];
  const missing: string[] = [];
  for (const name of add) {
    try {
      await gh(['api', `${base}/labels/${encodeURIComponent(name)}`]);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      missing.push(name);
      continue;
    }
    await gh(['api', '-X', 'POST', `${base}/issues/${ref.n}/labels`, '-f', `labels[]=${name}`]);
  }
  for (const name of remove) {
    try {
      await gh(['api', '-X', 'DELETE', `${base}/issues/${ref.n}/labels/${encodeURIComponent(name)}`]);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  return missing;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  try {
    const [command, refText, ...rest] = argv;
    if (!command || !refText || !['set', 'ok', 'show'].includes(command)) {
      err('Usage: pr-status set|ok|show <owner/repo#N | #N> [options]');
      return 1;
    }
    const ref = await parseRef(refText, deps.gh);

    if (command === 'show') {
      out(JSON.stringify(parseStatus(await readStatusText(deps.gh, ref)), null, 2));
      return 0;
    }

    if (command === 'ok') {
      const dir = join(deps.home, '.pr-board');
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, 'checked.jsonl'), `${JSON.stringify({ ref: refString(ref), at: deps.now().toISOString() })}\n`);
      return 0;
    }

    const opts = parseSetArgs(rest);
    const questions = buildQuestions(opts.questions);
    const handedOver = await writeStatus(deps.gh, ref, opts, questions, deps.now());
    const missing = await syncLabels(deps.gh, ref, opts.waiting);
    for (const name of missing) {
      err(`Label "${name}" doesn't exist in ${ref.owner}/${ref.repo}; run cli/setup-labels.ts`);
    }
    const reviewProblem = handedOver ? await requestReview(deps.gh, ref, handedOver.author) : null;
    if (reviewProblem) err(reviewProblem);
    return missing.length > 0 || reviewProblem ? 1 : 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  const { homedir } = await import('node:os');
  process.exitCode = await main(process.argv.slice(2), { gh, now: () => new Date(), home: homedir() });
}
