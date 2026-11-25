import { itemsProblem, parseItem } from '../src/shared/backlog.ts';
import { OWNER_LOGIN } from '../src/shared/config.ts';
import { BoardError, boardCall, realBoardDeps, where, workPath, type BoardDeps } from './board.ts';
import { pickUp } from './pickup.ts';
import { gh, parseRef, refString } from './gh.ts';
import { message } from '../src/shared/helpers.ts';
import type { Deps as BaseDeps, Gh, Ref } from './gh.ts';

export interface Deps extends BaseDeps {
  board: BoardDeps;
}

const USAGE = 'Usage: pr-status set <owner/repo#N | #N> --gate design|implementation|prep --state working|paused|complete|parked [--ask <text>] [--question "Q? (**default** | other)"]… [--to-test <text>] [--reason <text>] [--no-design] [--replaces <N>] [--issue <N>]';
const OTHER_USAGE = 'Usage: pr-status ok|show <owner/repo#N | #N>   or   pr-status import <owner/repo#N | #N> --json <file>   (import is for the switch-over to the board only; don\'t use it otherwise)';

const BACKLOG_COMMANDS = ['propose', 'pick-up', 'proposal-done'];
const BACKLOG_USAGE = 'For backlog sessions: pr-status propose <owner/repo> [--item "#N | pick up|later|close | reason"]…   pr-status pick-up <owner/repo#N>   pr-status proposal-done <owner/repo> [--problem <text>]';

/** The commands a backlog session runs, which name a repo rather than an item. */
async function backlogCommand(deps: Deps, command: 'propose' | 'proposal-done', repo: string, rest: string[], out: (l: string) => void): Promise<number> {
  if (!/^[^/\s#]+\/[^/\s#]+$/.test(repo)) throw new Error(`${command} needs the repo as owner/name, not "${repo}"`);
  const flag = command === 'propose' ? '--item' : '--problem';
  const values: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== flag) throw new Error(`Unknown option ${rest[i]}. ${BACKLOG_USAGE}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    values.push(value);
  }
  if (command === 'propose') {
    const items = values.map(parseItem);
    const problem = itemsProblem(items);
    if (problem) throw new Error(problem);
    await boardCall(deps.board, 'POST', '/api/proposal-write', { repo, items });
    out(`Wrote the proposal for ${repo} to the board, with ${items.length} ${items.length === 1 ? 'issue' : 'issues'}.`);
    return 0;
  }
  if (values.length > 1) throw new Error('Give --problem once');
  if (values[0] !== undefined && /[\r\n]/.test(values[0])) throw new Error('--problem must be one line');
  await boardCall(deps.board, 'POST', '/api/proposal-done', { repo, problem: values[0] ?? '' });
  out(values[0] ? `Handed the proposal for ${repo} back with what couldn't be done.` : `Marked the proposal for ${repo} done.`);
  return 0;
}

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
  // Everything else about the status is checked by the board, which refuses before writing anything.
  if (!opts.gate || !opts.state) throw new Error(USAGE);
  return opts;
}

interface Item { isPr: boolean; author: string | null }

async function readItem(gh: Gh, ref: Ref): Promise<Item> {
  const item = JSON.parse(await gh(['api', `repos/${ref.owner}/${ref.repo}/issues/${ref.n}`])) as {
    pull_request?: unknown; user?: { login: string } | null;
  };
  return { isPr: Boolean(item.pull_request), author: item.user?.login ?? null };
}

/** Asks the board's owner to review, so GitHub notifies them. Returns what went wrong, or null. */
async function requestReview(gh: Gh, ref: Ref, author: string | null): Promise<string | null> {
  if (author === OWNER_LOGIN) return null; // GitHub won't ask someone to review their own PR.
  try {
    await gh(['api', '-X', 'POST', `repos/${ref.owner}/${ref.repo}/pulls/${ref.n}/requested_reviewers`, '-f', `reviewers[]=${OWNER_LOGIN}`]);
    return null;
  } catch (e) {
    return `Couldn't ask ${OWNER_LOGIN} to review ${refString(ref)}: ${message(e)}`;
  }
}

async function setStatus(deps: Deps, ref: Ref, opts: SetOptions, out: (l: string) => void): Promise<string[]> {
  // With no --issue, the board links a PR to its issue from what GitHub says.
  const sent = await boardCall<{ record: { version: number }; handedOver: boolean }>(deps.board, 'POST', '/api/status', {
    ...where(ref), gate: opts.gate, state: opts.state, ask: opts.ask, questions: opts.questions,
    toTest: opts.toTest, reason: opts.reason, noDesign: opts.noDesign, issue: opts.issue, replaces: opts.replaces,
  });
  out(`Recorded ${refString(ref)} at ${opts.gate}, ${opts.state} (version ${sent.record.version})`);
  if (!sent.handedOver) return [];
  // Running set again won't ask for the review, since the record is already the owner's turn; so say how to ask by hand.
  const asked = `⚠️ The status was recorded on the board, but ${OWNER_LOGIN} wasn't asked to review, so GitHub won't notify them.`;
  const command = `gh pr edit ${ref.n} -R ${ref.owner}/${ref.repo} --add-reviewer ${OWNER_LOGIN}`;
  let item: Item;
  try {
    item = await readItem(deps.gh, ref);
  } catch (e) {
    // Whether the item is a PR isn't known here, and the command works only on one.
    return [`Couldn't read ${refString(ref)} from GitHub: ${message(e)}`, `${asked} If #${ref.n} is a pull request, run: ${command}`];
  }
  if (!item.isPr) return [];
  const problem = await requestReview(deps.gh, ref, item.author);
  return problem ? [problem, `${asked} Run: ${command}`] : [];
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  try {
    const [command, refText, ...rest] = argv;
    if (!command || !refText || !['set', 'ok', 'show', 'import', ...BACKLOG_COMMANDS].includes(command)) {
      err(`${USAGE}\n${OTHER_USAGE}\n${BACKLOG_USAGE}`);
      return 1;
    }
    if (command === 'propose' || command === 'proposal-done') return await backlogCommand(deps, command, refText, rest, out);
    if (command === 'pick-up') {
      const ref = await parseRef(refText, deps.gh);
      await pickUp(deps.gh, deps.board, ref, null);
      out(`Picked up ${refString(ref)}: it has the in-progress label and waits on the board for a free session.`);
      return 0;
    }
    const opts = command === 'set' ? parseSetArgs(rest) : null;
    const ref = await parseRef(refText, deps.gh);

    if (opts) {
      const problems = await setStatus(deps, ref, opts, out);
      for (const p of problems) err(p);
      return problems.length > 0 ? 1 : 0;
    }

    if (command === 'ok') {
      await boardCall(deps.board, 'POST', '/api/ok', where(ref));
      return 0;
    }

    if (command === 'show') {
      try {
        const work = await boardCall(deps.board, 'GET', workPath(ref));
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
      throw new Error(`Couldn't read a JSON record from ${file}: ${message(e)}`);
    }
    await boardCall(deps.board, 'POST', '/api/import', { ...where(ref), record });
    out(`Imported ${refString(ref)}`);
    return 0;
  } catch (e) {
    err(message(e));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    gh,
    board: realBoardDeps(),
  });
}
