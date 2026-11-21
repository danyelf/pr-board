import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { OWNER_LOGIN } from '../src/shared/config.ts';
import { GATES, STATES, Refused, parseQuestion } from '../src/shared/work.ts';
import { BoardError, boardCall, type BoardDeps } from './board.ts';
import { gh, parseRef, refString } from './gh.ts';
import type { Deps as BaseDeps, Gh, Ref } from './gh.ts';

export interface Deps extends BaseDeps {
  board: BoardDeps;
}

const USAGE = 'Usage: pr-status set <owner/repo#N | #N> --gate design|implementation|prep --state working|paused|complete|parked [--ask <text>] [--question "Q? (**default** | other)"]… [--to-test <text>] [--reason <text>] [--no-design] [--replaces <N>] [--issue <N>]';
const OTHER_USAGE = 'Usage: pr-status ok|show <owner/repo#N | #N>   or   pr-status import <owner/repo#N | #N> --json <file>   (import is for the switch-over to the board only; don\'t use it otherwise)';

interface SetOptions {
  gate: string;
  state: string;
  ask: string;
  questions: string[];
  toTest: string | null;
  reason: string | null;
  noDesign: boolean;
  replaces: number | null;
  issue: number | null;
}

function parseSetArgs(args: string[]): SetOptions {
  const opts: SetOptions = { gate: '', state: '', ask: '', questions: [], toTest: null, reason: null, noDesign: false, replaces: null, issue: null };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--no-design') {
      opts.noDesign = true;
      continue;
    }
    const value = args[i + 1];
    if (!flag.startsWith('--')) throw new Error(`Unexpected "${flag}"`);
    if (!['--gate', '--state', '--ask', '--question', '--to-test', '--reason', '--replaces', '--issue'].includes(flag)) throw new Error(`Unknown option ${flag}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag !== '--gate' && flag !== '--state' && /[\r\n]/.test(value)) {
      throw new Error(`${flag} must be one line; join the steps with "; " or "1) … 2) …" instead of line breaks`);
    }
    if (flag === '--gate') opts.gate = value;
    else if (flag === '--state') opts.state = value;
    else if (flag === '--ask') opts.ask = value;
    else if (flag === '--question') opts.questions.push(value);
    else if (flag === '--to-test') opts.toTest = value;
    else if (flag === '--reason') opts.reason = value;
    else {
      if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a number`);
      if (flag === '--replaces') opts.replaces = Number(value);
      else opts.issue = Number(value);
    }
  }
  if (!opts.gate || !opts.state) throw new Error(USAGE);
  if (!(GATES as readonly string[]).includes(opts.gate)) throw new Error(`--gate must be ${GATES.slice(0, -1).join(', ')} or ${GATES.at(-1)}`);
  if (!(STATES as readonly string[]).includes(opts.state)) throw new Error(`--state must be ${STATES.slice(0, -1).join(', ')} or ${STATES.at(-1)}`);
  // Check the questions here so a mistake is caught before anything is sent.
  opts.questions.forEach((q, i) => parseQuestion(q, i + 1));
  return opts;
}

interface Item { isPr: boolean; body: string; author: string | null }

async function readItem(gh: Gh, ref: Ref): Promise<Item> {
  const item = JSON.parse(await gh(['api', `repos/${ref.owner}/${ref.repo}/issues/${ref.n}`])) as {
    pull_request?: unknown; body?: string | null; user?: { login: string } | null;
  };
  return { isPr: Boolean(item.pull_request), body: item.body ?? '', author: item.user?.login ?? null };
}

/** The issue a PR says it closes or refers to, if its description names one. */
function issueNamedBy(body: string): number | null {
  const match = /\b(?:closes|refs)\s+#(\d+)/i.exec(body);
  return match ? Number(match[1]) : null;
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

async function setStatus(deps: Deps, ref: Ref, opts: SetOptions, out: (l: string) => void): Promise<string[]> {
  let item: Item | null = null;
  let issue = opts.issue;
  if (issue === null) {
    item = await readItem(deps.gh, ref);
    if (item.isPr) issue = issueNamedBy(item.body);
  }
  const sent = await boardCall<{ record: { version: number }; handedOver: boolean }>(deps.board, 'POST', '/api/status', {
    repo: `${ref.owner}/${ref.repo}`, number: ref.n, gate: opts.gate, state: opts.state, ask: opts.ask, questions: opts.questions,
    toTest: opts.toTest, reason: opts.reason, noDesign: opts.noDesign, issue, replaces: opts.replaces,
  });
  out(`Recorded ${refString(ref)} at ${opts.gate}, ${opts.state} (version ${sent.record.version})`);
  if (!sent.handedOver) return [];
  item ??= await readItem(deps.gh, ref);
  if (!item.isPr) return [];
  const problem = await requestReview(deps.gh, ref, item.author);
  return problem ? [problem] : [];
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  try {
    const [command, refText, ...rest] = argv;
    if (!command || !refText || !['set', 'ok', 'show', 'import'].includes(command)) {
      err(`${USAGE}\n${OTHER_USAGE}`);
      return 1;
    }
    const opts = command === 'set' ? parseSetArgs(rest) : null;
    const ref = await parseRef(refText, deps.gh);
    const where = { repo: `${ref.owner}/${ref.repo}`, number: ref.n };

    if (opts) {
      const problems = await setStatus(deps, ref, opts, out);
      for (const p of problems) err(p);
      return problems.length > 0 ? 1 : 0;
    }

    if (command === 'ok') {
      await boardCall(deps.board, 'POST', '/api/ok', where);
      return 0;
    }

    if (command === 'show') {
      try {
        const work = await boardCall(deps.board, 'GET', `/api/work?repo=${encodeURIComponent(where.repo)}&number=${where.number}`);
        out(JSON.stringify(work, null, 2));
        return 0;
      } catch (e) {
        if (e instanceof BoardError && e.status === 404) {
          err(`${refString(ref)} has no record on the board`);
          return 1;
        }
        throw e;
      }
    }

    // import: for the switch-over only.
    const at = rest.indexOf('--json');
    const file = at === -1 ? undefined : rest[at + 1];
    if (!file) throw new Error('import needs --json <file>: the record to load, as JSON');
    let record: unknown;
    try {
      record = JSON.parse(deps.board.readFile(file));
    } catch (e) {
      throw new Error(`Couldn't read a JSON record from ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await boardCall(deps.board, 'POST', '/api/import', { ...where, record });
    out(`Imported ${refString(ref)}`);
    return 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    gh,
    board: { fetch, readFile: (p) => readFileSync(p, 'utf8'), env: process.env, home: homedir() },
  });
}
