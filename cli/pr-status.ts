import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStatus, renderStatus, replaceStatus } from '../src/shared/status.ts';
import type { Question, Status } from '../src/shared/types.ts';
import { flattenPages, gh, isNotFound } from './gh.ts';
import type { Deps, Gh } from './gh.ts';

export interface Ref { owner: string; repo: string; n: number }

const STATUS_MARKER = '<!-- status -->';
const LABEL_ON_DANYEL = 'on danyel';
const LABEL_PARKED = 'parked';

export function refString(r: Ref): string {
  return `${r.owner}/${r.repo}#${r.n}`;
}

export async function parseRef(text: string, gh: Gh): Promise<Ref> {
  const full = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(text);
  if (full) return { owner: full[1]!, repo: full[2]!, n: Number(full[3]) };
  const short = /^#(\d+)$/.exec(text);
  if (!short) throw new Error(`Can't read "${text}" as a reference; use owner/repo#N or #N`);
  const name = (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim();
  const [owner, repo] = name.split('/');
  if (!owner || !repo) throw new Error(`Couldn't work out the repo for ${text} from the current directory`);
  return { owner, repo, n: Number(short[1]) };
}

interface SetOptions {
  waiting: 'danyel' | 'claude' | 'nobody';
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
      return value;
    };
    if (flag === '--waiting') waiting = need();
    else if (flag === '--ask') opts.ask = need();
    else if (flag === '--question') opts.questions.push(need());
    else if (flag === '--to-test') opts.toTest = need();
    else throw new Error(`Unknown option ${flag}`);
  }
  if (waiting !== 'danyel' && waiting !== 'claude' && waiting !== 'nobody') {
    throw new Error('--waiting must be danyel, claude or nobody');
  }
  opts.waiting = waiting;
  return opts;
}

/** Parses "text (**a** | b)" through the shared status parser so the format has one definition. */
function buildQuestions(texts: string[]): Question[] {
  const section = [STATUS_MARKER, '**Waiting on:** nobody', '**Questions:**', ...texts.map((t, i) => `${i + 1}. ${t}`), '<!-- /status -->'].join('\n');
  const parsed = parseStatus(section);
  const questions = parsed?.questions ?? [];
  for (const q of questions) {
    if (q.defaultChoice === null) {
      throw new Error(`Question ${q.n} has no bold default. Give every question choices with one in bold, like "Colour? (**red** | green)".`);
    }
  }
  return questions;
}

const WAITING_NAME = { danyel: 'Danyel', claude: 'Claude', nobody: 'nobody' } as const;

function nextStatus(opts: SetOptions, questions: Question[], previous: Status | null, now: Date): Status {
  const waitingOn = WAITING_NAME[opts.waiting];
  const since = previous && previous.waitingOn === waitingOn && previous.since ? previous.since : now.toISOString();
  return { waitingOn, since, ask: opts.ask, questions, toTest: opts.toTest };
}

async function writeStatus(gh: Gh, ref: Ref, opts: SetOptions, questions: Question[], now: Date): Promise<void> {
  const base = `repos/${ref.owner}/${ref.repo}`;
  const item = JSON.parse(await gh(['api', `${base}/issues/${ref.n}`])) as { pull_request?: unknown; body?: string | null };
  if (item.pull_request) {
    const body = item.body ?? '';
    const status = nextStatus(opts, questions, parseStatus(body), now);
    await gh(['api', '-X', 'PATCH', `${base}/pulls/${ref.n}`, '-f', `body=${replaceStatus(body, status)}`]);
    return;
  }
  const login = (await gh(['api', 'user', '-q', '.login'])).trim();
  const comments = flattenPages(await gh(['api', `${base}/issues/${ref.n}/comments?per_page=100`])) as {
    id: number; body: string; user: { login: string };
  }[];
  const mine = comments.find((c) => c.user.login === login && c.body.includes(STATUS_MARKER));
  if (mine) {
    const status = nextStatus(opts, questions, parseStatus(mine.body), now);
    await gh(['api', '-X', 'PATCH', `${base}/issues/comments/${mine.id}`, '-f', `body=${replaceStatus(mine.body, status)}`]);
  } else {
    const status = nextStatus(opts, questions, null, now);
    await gh(['api', '-X', 'POST', `${base}/issues/${ref.n}/comments`, '-f', `body=${renderStatus(status)}`]);
  }
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
        const comments = flattenPages(await deps.gh(['api', `repos/${ref.owner}/${ref.repo}/issues/${ref.n}/comments?per_page=100`])) as { body: string }[];
        text = comments.find((c) => c.body.includes(STATUS_MARKER))?.body ?? '';
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
    await writeStatus(deps.gh, ref, opts, questions, deps.now());
    const missing = await syncLabels(deps.gh, ref, opts.waiting);
    for (const name of missing) {
      err(`Label "${name}" doesn't exist in ${ref.owner}/${ref.repo}; run cli/setup-labels.ts`);
    }
    return missing.length > 0 ? 1 : 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  const { homedir } = await import('node:os');
  process.exitCode = await main(process.argv.slice(2), { gh, now: () => new Date(), home: homedir() });
}
