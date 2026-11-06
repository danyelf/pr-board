import { readFileSync } from 'node:fs';

/**
 * Answers a per-repo GraphQL query the way GitHub would, from a whole repo's worth of recorded
 * pull requests and issues: each `pullRequests(...)` or `issues(...)` connection in the query gets
 * the nodes matching its `states` and `labels` arguments, cut to its `first` count, in recorded order
 * (the recording is newest-updated first). A connection that names several labels matches any of them.
 */
export interface RepoWorld { pullRequests: { nodes: any[] }; issues: { nodes: any[] } }

/**
 * The recorded torahmap repo, as it stood just before #573, #574 and #578 merged. The recording was
 * made a few minutes after; only open PRs are read, so the tests need them open.
 */
export function recordedRepo(): RepoWorld {
  const data = JSON.parse(readFileSync(new URL('./fixtures/graphql-items.json', import.meta.url), 'utf8')).data.r0;
  for (const pr of data.pullRequests.nodes) {
    if ([573, 574, 578].includes(pr.number)) Object.assign(pr, { merged: false, mergedAt: null, closedAt: null });
  }
  return data;
}

interface Connection {
  name: string; kind: 'pullRequests' | 'issues'; first: number; states: string[] | null; labels: string[] | null;
  /** The fields the query asks for on each item itself (not on the lists inside it). */
  fields: string[];
}

/** The names at the top level of the `nodes { ... }` selection that follows `from`; anything inside braces or brackets is skipped. */
function itemFields(query: string, from: number): string[] {
  const start = query.indexOf('{', query.indexOf('nodes', from));
  const names: string[] = [];
  let depth = 0;
  let paren = 0;
  for (let i = start; i < query.length; i++) {
    const ch = query[i]!;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (depth === 1 && paren === 0 && /[A-Za-z_]/.test(ch) && !/\w/.test(query[i - 1]!)) {
      names.push(/^\w+/.exec(query.slice(i))![0]);
    }
  }
  return names;
}

function connectionsIn(query: string): Connection[] {
  const seen = new Map<string, Connection>();
  for (const m of query.matchAll(/(?:(\w+):\s*)?\b(pullRequests|issues)\(([^)]*)\)/g)) {
    const [, alias, kind, args] = m as unknown as [string, string | undefined, 'pullRequests' | 'issues', string];
    const states = /states:\s*(\[[^\]]*\]|\w+)/.exec(args)?.[1];
    const labels = /labels:\s*\[([^\]]*)\]/.exec(args)?.[1];
    const name = alias ?? kind;
    seen.set(name, {
      name, kind,
      first: Number(/first:\s*(\d+)/.exec(args)?.[1] ?? 100),
      states: states ? states.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean) : null,
      labels: labels ? [...labels.matchAll(/"([^"]*)"/g)].map((x) => x[1]!) : null,
      fields: itemFields(query, m.index!),
    });
  }
  return [...seen.values()];
}

function stateOf(node: any, kind: Connection['kind']): string {
  if (kind === 'pullRequests' && node.merged) return 'MERGED';
  return node.closedAt ? 'CLOSED' : 'OPEN';
}

export function answerRepo(query: string, world: RepoWorld): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of connectionsIn(query)) {
    const matching = world[c.kind].nodes.filter((n) =>
      (c.states === null || c.states.includes(stateOf(n, c.kind))) &&
      (c.labels === null || n.labels.nodes.some((l: { name: string }) => c.labels!.includes(l.name))));
    const returned = matching.slice(0, c.first);
    // GitHub sends every field the query asks for, so a recording without one means the query and the
    // recording have drifted apart (a field was misspelled, or the recording is out of date).
    for (const node of returned) {
      const absent = c.fields.filter((f) => !Object.hasOwn(node, f));
      if (absent.length > 0) throw new Error(`The recorded ${c.kind} #${node.number} has no ${absent.join(', ')}, which the query asks for`);
    }
    out[c.name] = { pageInfo: { hasNextPage: matching.length > c.first }, nodes: returned };
  }
  return out;
}
