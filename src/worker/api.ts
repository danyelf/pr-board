// The board's interface: the page (the owner) reads the board and sends answers; Claude's tools on the Mac
// (the service token) write statuses and handle claims. Everything is JSON.
import type { Facts } from '../shared/facts.ts';
import { buildView, type BoardView, type CardView } from '../shared/view.ts';
import { GATES, STATES, Refused, type AnswerInput, type SetInput, type WorkRecord } from '../shared/work.ts';
import type { Caller, Env } from './access.ts';
import type { setLabels } from './github.ts';
import { addAnswer, claim, confirm, endWork, findWork, giveUp, importWork, openWork, serviceClaims, setStatus, unclaim, unclaimedAnswers, unclaimedOlderThan, type ItemRef } from './store.ts';

export interface FactsResult {
  facts: Facts[];
  errors: string[];
  /** True when the facts came from the cache, so the labels they show may be out of date. */
  fromCache: boolean;
}

export interface ApiDeps {
  now: () => Date;
  /** `extra` names items to read even when they have no record yet. */
  facts: (env: Env, records: WorkRecord[], fresh: boolean, extra: ItemRef[]) => Promise<FactsResult>;
  setLabels: typeof setLabels;
  waitUntil: (p: Promise<unknown>) => void;
}

const MAX_BODY_BYTES = 64 * 1024;

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(b: Record<string, unknown>, key: string): string {
  const v = b[key];
  if (typeof v !== 'string' || v === '') throw new BadRequest(`"${key}" must be a non-empty string`);
  return v;
}
function int(b: Record<string, unknown>, key: string): number {
  const v = b[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new BadRequest(`"${key}" must be a positive whole number`);
  return v;
}
function intOrNull(b: Record<string, unknown>, key: string): number | null {
  return b[key] === undefined || b[key] === null ? null : int(b, key);
}
function strOrNull(b: Record<string, unknown>, key: string): string | null {
  const v = b[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new BadRequest(`"${key}" must be text`);
  return v;
}
function ids(b: Record<string, unknown>): number[] {
  const v = b.answerIds;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isInteger(x))) throw new BadRequest('"answerIds" must be a list of whole numbers');
  return v as number[];
}
function refOf(b: Record<string, unknown>): ItemRef {
  return { repo: str(b, 'repo'), n: int(b, 'number') };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new TooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest('The body is not valid JSON');
  }
  if (!isObject(body)) throw new BadRequest('The body must be a JSON object');
  return body;
}

class TooLarge extends Error {}

const keyOf = (f: Facts) => `${f.repo}#${f.number}`;

/** Queues the label changes each card needs; the facts say what each item has now. */
function queueLabels(env: Env, deps: ApiDeps, cards: CardView[], facts: Facts[]): void {
  const byKey = new Map(facts.map((f) => [keyOf(f), f]));
  for (const card of cards) {
    const f = byKey.get(card.key);
    if (!f || (card.labels.add.length === 0 && card.labels.remove.length === 0)) continue;
    // A failed label write is not worth failing the request, and the next fresh read tries again.
    deps.waitUntil(deps.setLabels(env.GITHUB_TOKEN, f, card.labels.add, card.labels.remove).catch(() => undefined));
  }
}

async function cardFor(env: Env, deps: ApiDeps, ref: ItemRef): Promise<CardView | null> {
  const record = await findWork(env.DB, ref);
  if (!record) return null;
  const { records, answers } = await openWork(env.DB);
  const got = await deps.facts(env, records, false, []);
  const view = buildView(records, answers, got.facts, got.errors, deps.now());
  return view.everything.find((c) => c.key === `${record.repo}#${record.pr ?? record.issue}`) ?? null;
}

async function board(env: Env, deps: ApiDeps): Promise<BoardView> {
  const { records, answers } = await openWork(env.DB);
  const got = await deps.facts(env, records, false, []);
  const now = deps.now();
  const byKey = new Map(got.facts.map((f) => [keyOf(f), f]));
  const open: WorkRecord[] = [];
  for (const r of records) {
    const f = byKey.get(`${r.repo}#${r.pr ?? r.issue}`);
    // Only an item whose facts were read can be said to have closed.
    if (f && (f.merged || f.closedAt !== null)) await endWork(env.DB, r.id, f.merged ? 'merged' : 'closed', now.toISOString());
    else open.push(r);
  }
  const view = buildView(open, answers, got.facts, got.errors, now);
  if (!got.fromCache) queueLabels(env, deps, view.everything, got.facts);
  return view;
}

function answerInput(b: Record<string, unknown>): AnswerInput {
  const choices = b.choices ?? {};
  if (!isObject(choices) || Object.values(choices).some((c) => typeof c !== 'string')) throw new BadRequest('"choices" must map question numbers to text');
  const note = b.note ?? '';
  if (typeof note !== 'string') throw new BadRequest('"note" must be text');
  return { version: int(b, 'version'), choices: choices as Record<string, string>, approval: strOrNull(b, 'approval'), note };
}

async function status(env: Env, deps: ApiDeps, b: Record<string, unknown>): Promise<Response> {
  const ref = refOf(b);
  const questions = b.questions ?? [];
  if (!Array.isArray(questions) || questions.some((q) => typeof q !== 'string')) throw new BadRequest('"questions" must be a list of text');
  if (!GATES.includes(b.gate as never)) throw new BadRequest(`"gate" must be one of ${GATES.join(', ')}`);
  if (!STATES.includes(b.state as never)) throw new BadRequest(`"state" must be one of ${STATES.join(', ')}`);
  if (typeof b.ask !== 'string') throw new BadRequest('"ask" must be text');
  const noDesign = b.noDesign ?? false;
  if (typeof noDesign !== 'boolean') throw new BadRequest('"noDesign" must be true or false');

  const named = intOrNull(b, 'issue');
  const existing = await findWork(env.DB, ref);
  const got = await deps.facts(env, existing ? [existing] : [], true, named === null ? [ref] : [ref, { repo: ref.repo, n: named }]);
  const factsOf = (facts: Facts[], n: number) => facts.find((x) => x.repo === ref.repo && x.number === n);
  const unreadable = (n: number) => json({ error: `Couldn't read ${ref.repo}#${n} from GitHub${got.errors.length > 0 ? `: ${got.errors.join('; ')}` : ''}` }, 502);
  const f = factsOf(got.facts, ref.n);
  if (!f) return unreadable(ref.n);

  // A number held as a record's issue must really be an issue, or a lookup by that number could find the wrong record.
  let issue: number | null = null;
  if (named !== null) {
    const nf = factsOf(got.facts, named);
    if (!nf) return unreadable(named);
    if (nf.kind !== 'issue') throw new Refused(`${ref.repo}#${named} is a pull request, not an issue; --issue must name an issue`);
    issue = named;
  } else if (f.kind === 'pr' && f.linkedIssue !== null) {
    // With no issue named, a PR joins the issue GitHub links it to (Closes, Fixes, Resolves or Refs), when that is an issue.
    const linked = f.linkedIssue;
    const lf = factsOf(got.facts, linked) ?? factsOf((await deps.facts(env, [], true, [{ repo: ref.repo, n: linked }])).facts, linked);
    issue = lf?.kind === 'issue' ? linked : null;
  }

  const input: SetInput & { issue: number | null; replaces: number | null } = {
    gate: b.gate as SetInput['gate'], state: b.state as SetInput['state'], ask: b.ask, questions: questions as string[],
    toTest: strOrNull(b, 'toTest'), reason: strOrNull(b, 'reason'), noDesign,
    // The head and the kind come from GitHub, whatever the client says.
    headSha: f.headSha, isPr: f.kind === 'pr',
    issue, replaces: intOrNull(b, 'replaces'),
  };
  const result = await setStatus(env.DB, ref, input, deps.now().toISOString());

  const { records, answers } = await openWork(env.DB);
  const view = buildView(records, answers, got.facts, got.errors, deps.now());
  queueLabels(env, deps, view.everything, got.facts);
  return json(result);
}

type Imported = Parameters<typeof importWork>[2];

/**
 * Checks every field of a record brought in at the switch-over, so the board never stores one it can't read back,
 * and checks that the record belongs to the item named: its PR when it has one, otherwise its issue.
 */
function importedRecord(ref: ItemRef, v: unknown): Imported {
  const no = (why: string): never => { throw new Refused(`The record can't be imported: ${why}`); };
  if (!isObject(v)) return no('it must be a JSON object');
  const text = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : no(`"${k}" must be text`));
  const textOrNull = (k: string) => (v[k] === null || typeof v[k] === 'string' ? (v[k] as string | null) : no(`"${k}" must be text or null`));
  const time = (k: string) => (Number.isNaN(Date.parse(text(k))) ? no(`"${k}" must be a time`) : text(k));
  const whole = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0;
  const numberOrNull = (k: string) => (v[k] === null || (whole(v[k]) && (v[k] as number) > 0) ? (v[k] as number | null) : no(`"${k}" must be a number or null`));
  const oneOf = <T extends string>(k: string, list: readonly T[]) => (list.includes(v[k] as T) ? (v[k] as T) : no(`"${k}" must be one of ${list.join(', ')}`));

  const questions = Array.isArray(v.questions) ? v.questions : no('"questions" must be a list');
  for (const q of questions) {
    const ok = isObject(q) && whole(q.n) && typeof q.text === 'string' && typeof q.defaultChoice === 'string'
      && Array.isArray(q.choices) && q.choices.every((c) => typeof c === 'string');
    if (!ok) no('each question must have a number "n", "text", "choices" and a "defaultChoice"');
  }
  const approved = isObject(v.approved) ? v.approved : no('"approved" must be an object');
  for (const [k, at] of Object.entries(approved)) {
    if ((k !== 'design' && k !== 'implementation') || typeof at !== 'string' || Number.isNaN(Date.parse(at))) no('"approved" may only give a time for design and implementation');
  }
  const rounds = isObject(v.rounds) ? v.rounds : no('"rounds" must be an object');
  if (Object.keys(rounds).length !== GATES.length || !GATES.every((g) => whole(rounds[g]))) no(`"rounds" must give a count for each of ${GATES.join(', ')}`);
  if (typeof v.hasDesign !== 'boolean') no('"hasDesign" must be true or false');

  const r: Imported = {
    issue: numberOrNull('issue'), pr: numberOrNull('pr'), hasDesign: v.hasDesign as boolean,
    gate: oneOf('gate', GATES), state: oneOf('state', STATES), reached: oneOf('reached', GATES),
    ask: text('ask'), questions: questions as Imported['questions'], toTest: textOrNull('toTest'), backReason: textOrNull('backReason'),
    approved: approved as Imported['approved'], rounds: rounds as Imported['rounds'], prepSha: textOrNull('prepSha'),
    turnSince: time('turnSince'), writtenAt: time('writtenAt'), startedAt: time('startedAt'),
  };
  const known = r.pr ?? r.issue;
  if (known !== ref.n) no(`it is for #${known ?? 'nothing'} (its ${r.pr !== null ? 'PR' : 'issue'}), not #${ref.n}`);
  return r;
}

async function importRecord(env: Env, deps: ApiDeps, b: Record<string, unknown>): Promise<Response> {
  const ref = refOf(b);
  const record = await importWork(env.DB, ref, importedRecord(ref, b.record), deps.now().toISOString());
  return json({ record });
}

export async function handleApi(req: Request, env: Env, who: Caller, deps: ApiDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const get = req.method === 'GET';
  const post = req.method === 'POST';

  const OWNER_GET = ['/api/board'];
  const OWNER_POST = ['/api/answer'];
  const CLAUDE_GET = ['/api/work', '/api/service-claims'];
  const CLAUDE_POST = ['/api/status', '/api/ok', '/api/unclaimed', '/api/claim', '/api/unclaim', '/api/gave-up', '/api/import'];
  const known = [...OWNER_GET, ...OWNER_POST, ...CLAUDE_GET, ...CLAUDE_POST];
  if (!known.includes(path)) return json({ error: 'Not found' }, 404);
  const isGetRoute = OWNER_GET.includes(path) || CLAUDE_GET.includes(path);
  if ((isGetRoute && !get) || (!isGetRoute && !post)) return json({ error: 'Method not allowed' }, 405);
  const wants: Caller = OWNER_GET.includes(path) || OWNER_POST.includes(path) ? 'owner' : 'claude';
  if (who !== wants) return json({ error: `This is for ${wants === 'owner' ? 'the owner' : 'Claude'}` }, 403);

  if (post) {
    // A page on another site could make the browser send the owner's cookie; it can't make the Origin match.
    if (who === 'owner' && req.headers.get('Origin') !== url.origin) return json({ error: 'Origin not allowed' }, 403);
    if (!(req.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return json({ error: 'Send JSON with Content-Type: application/json' }, 400);
    }
  }

  const now = deps.now().toISOString();
  try {
    if (path === '/api/board') return json(await board(env, deps));
    if (path === '/api/work') {
      const n = Number(url.searchParams.get('number'));
      const repo = url.searchParams.get('repo');
      if (!repo || !Number.isInteger(n) || n < 1) throw new BadRequest('Give ?repo= and ?number=');
      const record = await findWork(env.DB, { repo, n });
      if (!record) return json({ error: `${repo}#${n} is not open on the board` }, 404);
      const { answers } = await openWork(env.DB);
      return json({ record, answers: answers.filter((a) => a.workId === record.id) });
    }
    if (path === '/api/service-claims') return json(await serviceClaims(env.DB));

    const b = await readBody(req);
    switch (path) {
      case '/api/answer': {
        const ref = refOf(b);
        try {
          await addAnswer(env.DB, ref, answerInput(b), now);
        } catch (e) {
          if (!(e instanceof Refused)) throw e;
          return json({ error: e.message, card: await cardFor(env, deps, ref) }, 409);
        }
        return json({ card: await cardFor(env, deps, ref) });
      }
      case '/api/status': return await status(env, deps, b);
      case '/api/ok': return json({ record: await confirm(env.DB, refOf(b), now) });
      case '/api/unclaimed': {
        if (Array.isArray(b.refs)) {
          const refs = b.refs.map((r) => {
            if (!isObject(r)) throw new BadRequest('Each ref needs a repo and a number');
            return refOf(r);
          });
          return json(await unclaimedAnswers(env.DB, refs));
        }
        const age = b.olderThanMs;
        if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) throw new BadRequest('Send "refs" or "olderThanMs"');
        return json(await unclaimedOlderThan(env.DB, new Date(deps.now().getTime() - age).toISOString()));
      }
      case '/api/claim': {
        if (b.by !== 'session' && b.by !== 'service') throw new BadRequest('"by" must be session or service');
        return json(await claim(env.DB, refOf(b), b.by, now));
      }
      case '/api/unclaim': {
        await unclaim(env.DB, ids(b));
        return json({});
      }
      case '/api/gave-up': {
        await giveUp(env.DB, ids(b), strOrNull(b, 'hint') ?? '', now);
        return json({});
      }
      case '/api/import': return await importRecord(env, deps, b);
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof TooLarge) return json({ error: 'The body is larger than 64 KB' }, 413);
    if (e instanceof Refused) return json({ error: e.message }, 409);
    throw e;
  }
}
