import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LABEL_ON_DANYEL, LABEL_PARKED } from '../src/shared/names.ts';
import { hasStatusSection } from '../src/shared/status.ts';
import { currentRepo, flattenPages, gh, git, refString } from '../cli/gh.ts';
import type { Deps, Gh, Ref } from '../cli/gh.ts';

export interface HookDeps extends Deps {
  git: Gh;
  /** The home folder, where the list of "status is still right" notes is kept. */
  home: string;
  stdin: string;
}

interface Touched extends Ref { kind: 'pr' | 'issue' | 'unknown' }

interface Entry {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
}

interface ToolUse { id: string; command: string; cwd: string }

const TURN_LABELS = new Set([LABEL_ON_DANYEL, LABEL_PARKED]);
/** The status command Claude is told to run; it sits next to this hook's folder. */
const PR_STATUS_SCRIPT = join(import.meta.dirname, '..', 'cli', 'pr-status.ts');
const VALUE_FLAGS = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--title', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-B', '--base', '-H', '--head', '-r', '--reviewer', '-p', '--project']);

function contentParts(entry: Entry): Record<string, unknown>[] {
  const c = entry.message?.content;
  return Array.isArray(c) ? (c as Record<string, unknown>[]) : [];
}

/** Whether this transcript entry is Danyel typing (not a tool result or a system wrapper). */
function isDanyelTyping(entry: Entry): boolean {
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return false;
  const c = entry.message?.content;
  if (typeof c === 'string') return !c.trimStart().startsWith('<');
  const parts = contentParts(entry);
  if (parts.some((p) => p.type === 'tool_result')) return false;
  const text = parts.find((p) => p.type === 'text');
  return typeof text?.text === 'string' && !text.text.trimStart().startsWith('<');
}

/** A small shell tokenizer: handles quotes, and returns `;`, `&&`, `||`, `|` and newlines as separators. */
function splitCommands(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) tokens.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      endSegment();
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

function flagValue(tokens: string[], names: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (names.includes(t)) return tokens[i + 1] ?? null;
    for (const n of names) if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
  }
  return null;
}

/** The arguments after `gh pr|issue <subcommand>` that are not flags or the values of flags. */
function positionalArgs(tokens: string[]): string[] {
  const found: string[] = [];
  for (let i = 3; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (VALUE_FLAGS.has(t)) i++;
    else if (!t.startsWith('-')) found.push(t);
  }
  return found;
}

const URL_PATTERN = /github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d+)/;

/** Whether an argument names an item: a number, or the address of a PR or issue. */
function namesAnItem(arg: string): boolean {
  return /^\d+$/.test(arg) || URL_PATTERN.test(arg);
}

function fromUrl(url: string): Touched | null {
  const m = URL_PATTERN.exec(url);
  return m ? { owner: m[1]!, repo: m[2]!, n: Number(m[4]), kind: m[3] === 'pull' ? 'pr' : 'issue' } : null;
}

function resultText(entries: Entry[], toolUseId: string): string {
  for (const e of entries) {
    for (const p of contentParts(e)) {
      if (p.type === 'tool_result' && p.tool_use_id === toolUseId) {
        const c = p.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((x: { text?: string }) => x.text ?? '').join('\n');
      }
    }
  }
  return '';
}

type Repo = { owner: string; repo: string };

async function repoOf(deps: HookDeps, cwd: string, cache: Map<string, Repo>): Promise<Repo> {
  let repo = cache.get(cwd);
  if (!repo) {
    repo = await currentRepo(deps.gh, cwd);
    cache.set(cwd, repo);
  }
  return repo;
}

async function touchedBy(use: ToolUse, entries: Entry[], deps: HookDeps, cache: Map<string, Repo>): Promise<Touched[]> {
  const found: Touched[] = [];
  let cwd = use.cwd;
  for (const tokens of splitCommands(use.command)) {
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    const t = tokens.slice(i);
    if (t.some((x) => x.endsWith('pr-status.ts'))) continue;
    if (t[0] === 'cd' && t[1]) {
      cwd = t[1].startsWith('/') ? t[1] : join(cwd, t[1]);
      continue;
    }
    if (t[0] === 'gh' && (t[1] === 'pr' || t[1] === 'issue')) {
      const kind = t[1] === 'pr' ? 'pr' : 'issue';
      const sub = t[2];
      if (sub === 'create') {
        const url = fromUrl(resultText(entries, use.id));
        if (url) found.push(url);
        continue;
      }
      const editing = kind === 'pr' ? ['comment', 'edit', 'review'] : ['comment', 'edit'];
      if (!sub || !editing.includes(sub)) continue;
      const positional = positionalArgs(t);
      const target = positional.find(namesAnItem) ?? null;
      const url = target ? fromUrl(target) : null;
      if (url) {
        found.push(url);
        continue;
      }
      const repoFlag = flagValue(t, ['-R', '--repo']);
      const [owner, repo] = repoFlag ? repoFlag.split('/') : Object.values(await repoOf(deps, cwd, cache));
      if (!owner || !repo) continue;
      let n = target ? Number(target) : NaN;
      if (!target && kind === 'pr') {
        // No number given: gh means the PR of the current branch, or of the branch named.
        const branch = positional[0];
        const viewArgs = ['pr', 'view', ...(branch ? [branch] : []), ...(repoFlag ? ['-R', repoFlag] : []), '--json', 'number', '-q', '.number'];
        n = Number((await deps.gh(viewArgs, { cwd })).trim());
      }
      if (Number.isInteger(n) && n > 0) found.push({ owner, repo, n, kind });
    } else if (t[0] === 'gh' && t[1] === 'api') {
      const method = flagValue(t, ['-X', '--method'])?.toUpperCase();
      if (method !== 'PATCH' && method !== 'POST') continue;
      for (const arg of t.slice(2)) {
        const m = /(?:^|\/)repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(?:\/|$|\?)/.exec(arg);
        if (m) {
          found.push({ owner: m[1]!, repo: m[2]!, n: Number(m[4]), kind: m[3] === 'pulls' ? 'pr' : 'unknown' });
          break;
        }
      }
    } else if (t[0] === 'git') {
      let dir = cwd;
      let rest = t.slice(1);
      if (rest[0] === '-C' && rest[1]) {
        dir = rest[1];
        rest = rest.slice(2);
      }
      if (rest[0] !== 'push') continue;
      const positional = rest.slice(1).filter((x) => !x.startsWith('-'));
      const refspec = positional[1];
      let branch = refspec ? (refspec.includes(':') ? refspec.split(':')[1]! : refspec) : '';
      if (!branch || branch === 'HEAD') {
        branch = (await deps.git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      }
      const { owner, repo } = await repoOf(deps, dir, cache);
      const prs = JSON.parse(await deps.gh(['pr', 'list', '--head', branch, '--json', 'number'], { cwd: dir })) as { number: number }[];
      for (const pr of prs) found.push({ owner, repo, n: pr.number, kind: 'pr' });
    }
  }
  return found;
}

async function checkedRefs(home: string): Promise<{ ref: string; at: number }[]> {
  let text: string;
  try {
    text = await readFile(join(home, '.pr-board', 'checked.jsonl'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').filter(Boolean).map((l) => {
    const o = JSON.parse(l) as { ref: string; at: string };
    return { ref: o.ref, at: Date.parse(o.at) };
  });
}

async function isUpdated(item: Touched, turnStart: number, deps: HookDeps, checked: { ref: string; at: number }[]): Promise<boolean> {
  const ref = refString(item);
  if (checked.some((c) => c.ref === ref && c.at >= turnStart)) return true;

  const base = `repos/${item.owner}/${item.repo}/issues/${item.n}`;
  const events = flattenPages(await deps.gh(['api', `${base}/events?per_page=100`, '--paginate', '--slurp'])) as {
    event: string; label?: { name: string }; created_at: string;
  }[];
  if (events.some((e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label && TURN_LABELS.has(e.label.name) && Date.parse(e.created_at) >= turnStart)) {
    return true;
  }

  let kind = item.kind;
  if (kind === 'unknown') {
    const meta = JSON.parse(await deps.gh(['api', base])) as { pull_request?: unknown };
    kind = meta.pull_request ? 'pr' : 'issue';
  }
  if (kind === 'pr') {
    const query = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){lastEditedAt body}}}';
    const res = JSON.parse(await deps.gh(['api', 'graphql', '-f', `query=${query}`, '-F', `o=${item.owner}`, '-F', `r=${item.repo}`, '-F', `n=${item.n}`])) as {
      data: { repository: { pullRequest: { lastEditedAt: string | null; body: string } } };
    };
    const pr = res.data.repository.pullRequest;
    return pr.lastEditedAt !== null && Date.parse(pr.lastEditedAt) >= turnStart && hasStatusSection(pr.body);
  }
  const comments = flattenPages(await deps.gh(['api', `${base}/comments?per_page=100`, '--paginate', '--slurp'])) as { body: string; updated_at: string }[];
  return comments.some((c) => hasStatusSection(c.body) && Date.parse(c.updated_at) >= turnStart);
}

export async function main(deps: HookDeps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  try {
    const input = JSON.parse(deps.stdin) as { transcript_path: string; cwd?: string; stop_hook_active?: boolean };
    if (input.stop_hook_active) return 0;

    const entries = (await readFile(input.transcript_path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Entry);

    let turnStart: number | null = null;
    for (const e of entries) {
      if (e.timestamp && isDanyelTyping(e)) turnStart = Date.parse(e.timestamp);
    }
    if (turnStart === null) return 0;

    const uses: ToolUse[] = [];
    for (const e of entries) {
      if (e.type !== 'assistant' || !e.timestamp) continue;
      const at = Date.parse(e.timestamp);
      if (at < turnStart) continue;
      for (const p of contentParts(e)) {
        const command = (p.input as { command?: unknown } | undefined)?.command;
        if (p.type === 'tool_use' && p.name === 'Bash' && typeof command === 'string') {
          uses.push({ id: String(p.id), command, cwd: e.cwd ?? input.cwd ?? process.cwd() });
        }
      }
    }

    const cache = new Map<string, Repo>();
    const touched = new Map<string, Touched>();
    for (const use of uses) {
      for (const item of await touchedBy(use, entries, deps, cache)) {
        const ref = refString(item);
        const known = touched.get(ref);
        if (!known || known.kind === 'unknown') touched.set(ref, item);
      }
    }
    if (touched.size === 0) return 0;

    const checked = await checkedRefs(deps.home);
    const missing: string[] = [];
    for (const [ref, item] of touched) {
      if (!(await isUpdated(item, turnStart, deps, checked))) missing.push(ref);
    }
    if (missing.length === 0) return 0;

    out(JSON.stringify({
      decision: 'block',
      reason: `You changed ${missing.join(', ')} this turn but didn't update their status. Run: node ${PR_STATUS_SCRIPT} set <ref> --waiting … (or "ok <ref>" if the status is still right).`,
    }));
    return 0;
  } catch (e) {
    err(`status-check: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    return 0;
  }
}

if (import.meta.main) {
  const { homedir } = await import('node:os');
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  process.exitCode = await main({ gh, git, home: homedir(), stdin });
}
