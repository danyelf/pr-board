import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LABEL_ON_DANYEL, LABEL_PARKED, WAITING_ON, type WaitingOption } from '../src/shared/names.ts';
import { STATUS_CLOSE, STATUS_OPEN, parseStatus, pickStatusComment, renderStatus, replaceStatus, statusValueProblem } from '../src/shared/status.ts';
import type { Question, Status } from '../src/shared/types.ts';
import { currentRepo, flattenPages, gh, isNotFound, refString } from './gh.ts';
import type { Deps as BaseDeps, Gh, Ref } from './gh.ts';

export interface Deps extends BaseDeps {
  now: () => Date;
  /** The home folder, where the list of "status is still right" notes is kept. */
  home: string;
}

export async function parseRef(text: string, gh: Gh): Promise<Ref> {
  const full = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(text);
  if (full) return { owner: full[1]!, repo: full[2]!, n: Number(full[3]) };
  const short = /^#(\d+)$/.exec(text);
  if (!short) throw new Error(`Can't read "${text}" as a reference; use owner/repo#N or #N`);
  return { ...(await currentRepo(gh)), n: Number(short[1]) };
}

interface SetOptions {
  waiting: WaitingOption;
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
  const chosen = WAITING_ON.find((w) => w.option === waiting);
  if (!chosen) {
    const options = WAITING_ON.map((w) => w.option);
    throw new Error(`--waiting must be ${options.slice(0, -1).join(', ')} or ${options.at(-1)}`);
  }
  opts.waiting = chosen.option;
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
  const waitingOn = WAITING_ON.find((w) => w.option === opts.waiting)!.status;
  const since = previous && previous.waitingOn === waitingOn && previous.since ? previous.since : now.toISOString();
  return { waitingOn, since, ask: opts.ask, questions, toTest: opts.toTest };
}

/** A PR that has just been handed to Danyel, and who opened it; null otherwise. */
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
    const handedOver = opts.waiting === 'danyel' && previous?.waitingOn !== status.waitingOn;
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

/**
 * Asks the repo's owner to review, so GitHub notifies them. The board is for one person, whose
 * repos these are, so the owner is the person to ask. Returns a complaint, or null when all is well.
 */
async function requestOwnerReview(gh: Gh, ref: Ref, author: string | null): Promise<{ problem: string; failed: boolean } | null> {
  if (author === ref.owner) return null; // GitHub won't ask someone to review their own PR.
  const base = `repos/${ref.owner}/${ref.repo}`;
  try {
    const ownerType = (await gh(['api', base, '-q', '.owner.type'])).trim();
    if (ownerType !== 'User') {
      return { problem: `Didn't ask for a review: ${ref.owner}/${ref.repo} belongs to an organization, not a person`, failed: false };
    }
    await gh(['api', '-X', 'POST', `${base}/pulls/${ref.n}/requested_reviewers`, '-f', `reviewers[]=${ref.owner}`]);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { problem: `Couldn't ask ${ref.owner} to review ${refString(ref)}: ${message}`, failed: true };
  }
}

/** Every comment on the item, oldest first, however many pages there are. */
async function issueComments<T extends { body: string }>(gh: Gh, ref: Ref): Promise<T[]> {
  const url = `repos/${ref.owner}/${ref.repo}/issues/${ref.n}/comments?per_page=100`;
  return flattenPages(await gh(['api', url, '--paginate', '--slurp'])) as T[];
}

/** Returns the names of labels that were wanted but don't exist in the repo. */
async function syncLabels(gh: Gh, ref: Ref, waiting: SetOptions['waiting']): Promise<string[]> {
  const base = `repos/${ref.owner}/${ref.repo}`;
  const add = waiting === 'danyel' ? [LABEL_ON_DANYEL] : waiting === 'nobody' ? [LABEL_PARKED] : [];
  const remove = waiting === 'danyel' ? [LABEL_PARKED] : waiting === 'nobody' ? [LABEL_ON_DANYEL] : [LABEL_ON_DANYEL, LABEL_PARKED];
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
      const item = JSON.parse(await deps.gh(['api', `repos/${ref.owner}/${ref.repo}/issues/${ref.n}`])) as { pull_request?: unknown; body?: string | null };
      let text = item.body ?? '';
      if (!item.pull_request) {
        text = pickStatusComment(await issueComments(deps.gh, ref))?.body ?? '';
      }
      out(JSON.stringify(parseStatus(text), null, 2));
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
    const review = handedOver ? await requestOwnerReview(deps.gh, ref, handedOver.author) : null;
    if (review) err(review.problem);
    return missing.length > 0 || review?.failed ? 1 : 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  const { homedir } = await import('node:os');
  process.exitCode = await main(process.argv.slice(2), { gh, now: () => new Date(), home: homedir() });
}
