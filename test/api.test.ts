import { beforeEach, describe, expect, it } from 'vitest';
import type { Facts } from '../src/shared/facts.ts';
import type { Env } from '../src/worker/access.ts';
import { handleApi, type ApiDeps } from '../src/worker/api.ts';
import { findWork, setStatus, type Db, type ItemRef } from '../src/worker/store.ts';
import { NOW, facts } from './view-helpers.ts';
import { sqliteDb } from './sqlite-d1.ts';

const ORIGIN = 'https://board.example';
const NOW_ISO = NOW.toISOString();

const assert = {
  equal: (actual: unknown, expected: unknown) => expect(actual).toBe(expected),
  deepEqual: (actual: unknown, expected: unknown) => expect(actual).toEqual(expected),
  ok: (value: unknown) => expect(value).toBeTruthy(),
  match: (text: string, pattern: RegExp) => expect(text).toMatch(pattern),
};

interface Harness {
  db: Db;
  env: Env;
  deps: ApiDeps;
  items: Facts[];
  fromCache: boolean;
  labelCalls: { number: number; add: string[]; remove: string[] }[];
  waiting: Promise<unknown>[];
  askedFresh: boolean[];
}

function harness(): Harness {
  const db = sqliteDb();
  const h: Harness = { db, env: { DB: db, GITHUB_TOKEN: 't' } as Env, items: [], fromCache: false, labelCalls: [], waiting: [], askedFresh: [], deps: undefined as never };
  h.deps = {
    now: () => NOW,
    facts: async (_env, _records, fresh) => {
      h.askedFresh.push(fresh);
      return { facts: h.items, errors: [], fromCache: h.fromCache };
    },
    setLabels: async (_token, f, add, remove) => {
      h.labelCalls.push({ number: f.number, add, remove });
    },
    waitUntil: (p) => {
      h.waiting.push(p);
    },
  };
  return h;
}

function call(h: Harness, who: 'owner' | 'claude', method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] ??= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (method === 'POST' && who === 'owner') (init.headers as Record<string, string>)['Origin'] ??= ORIGIN;
  return handleApi(new Request(`${ORIGIN}${path}`, init), h.env, who, h.deps);
}

const STATUS = { repo: 'o/r', number: 5, gate: 'implementation', state: 'paused', ask: 'One thing', questions: ['Colour? (**gold** | grey)'], toTest: null, reason: null, noDesign: true, issue: null, replaces: null };

async function seedPaused(h: Harness) {
  h.items = [facts({ number: 5 })];
  const res = await call(h, 'claude', 'POST', '/api/status', STATUS);
  assert.equal(res.status, 200);
  return ((await res.json()) as { record: { version: number } }).record;
}

describe('the API', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  describe('who may call', () => {
    it('refuses the owner on a Claude route and Claude on an owner route', async () => {
      assert.equal((await call(h, 'owner', 'POST', '/api/status', STATUS)).status, 403);
      assert.equal((await call(h, 'owner', 'GET', '/api/service-claims')).status, 403);
      assert.equal((await call(h, 'claude', 'GET', '/api/board')).status, 403);
      assert.equal((await call(h, 'claude', 'POST', '/api/answer', {}, {})).status, 403);
    });
    it('answers 404 for an unknown route', async () => {
      assert.equal((await call(h, 'owner', 'GET', '/api/nothing')).status, 404);
    });
  });

  describe('every POST', () => {
    it('needs a JSON content type', async () => {
      const res = await call(h, 'claude', 'POST', '/api/ok', '{"repo":"o/r","number":5}', { 'Content-Type': 'text/plain' });
      assert.equal(res.status, 400);
    });
    it('refuses an owner POST with a foreign Origin, or none', async () => {
      assert.equal((await call(h, 'owner', 'POST', '/api/answer', {}, { Origin: 'https://evil.example' })).status, 403);
      const noOrigin = await handleApi(new Request(`${ORIGIN}/api/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), h.env, 'owner', h.deps);
      assert.equal(noOrigin.status, 403);
    });
    it('lets Claude POST without an Origin', async () => {
      await seedPaused(h);
      assert.equal((await call(h, 'claude', 'POST', '/api/ok', { repo: 'o/r', number: 5 })).status, 200);
    });
    it('refuses a body over 64 KB', async () => {
      const res = await call(h, 'claude', 'POST', '/api/ok', { repo: 'o/r', number: 5, pad: 'x'.repeat(70 * 1024) });
      assert.equal(res.status, 413);
    });
    it('refuses malformed JSON and missing fields with 400', async () => {
      assert.equal((await call(h, 'claude', 'POST', '/api/ok', '{nope')).status, 400);
      assert.equal((await call(h, 'claude', 'POST', '/api/ok', { repo: 'o/r' })).status, 400);
    });
  });

  describe('/api/status', () => {
    it('stores the status and says the item was handed over', async () => {
      h.items = [facts({ number: 5 })];
      const res = await call(h, 'claude', 'POST', '/api/status', STATUS);
      const body = (await res.json()) as { record: { gate: string; version: number }; handedOver: boolean };
      assert.equal(res.status, 200);
      assert.equal(body.record.gate, 'implementation');
      assert.equal(body.record.version, 1);
      assert.equal(body.handedOver, true);
      assert.deepEqual(h.askedFresh, [true]);
    });
    it('takes the head and the kind from GitHub, not from the client', async () => {
      h.items = [facts({ number: 5, headSha: 'abc123' })];
      await call(h, 'claude', 'POST', '/api/status', { ...STATUS, state: 'complete', questions: [], toTest: 'click it' });
      const approve = await call(h, 'owner', 'POST', '/api/answer', { repo: 'o/r', number: 5, version: 1, choices: {}, approval: 'looks good, prep for merge', note: '' });
      assert.equal(approve.status, 200);
      const done = await call(h, 'claude', 'POST', '/api/status', {
        ...STATUS, gate: 'prep', state: 'complete', questions: [], ask: 'Ready', noDesign: false, headSha: 'forged', isPr: false,
      });
      assert.equal(done.status, 200);
      const record = await findWork(h.db, { repo: 'o/r', n: 5 });
      assert.equal(record?.prepSha, 'abc123');
    });
    it('queues the label changes', async () => {
      await seedPaused(h);
      await Promise.all(h.waiting);
      assert.equal(h.labelCalls.length, 1);
      assert.ok(h.labelCalls[0]!.add.includes('gate: implementation'));
    });
    it('says so when GitHub cannot show the item', async () => {
      const res = await call(h, 'claude', 'POST', '/api/status', STATUS);
      assert.equal(res.status, 502);
    });
    it('turns a refused status into 409', async () => {
      h.items = [facts({ number: 5 })];
      const res = await call(h, 'claude', 'POST', '/api/status', { ...STATUS, questions: [] });
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { error: string }).error, /question/);
    });
  });

  describe('/api/answer', () => {
    it('stores an answer and returns the fresh card', async () => {
      const rec = await seedPaused(h);
      const res = await call(h, 'owner', 'POST', '/api/answer', { repo: 'o/r', number: 5, version: rec.version, choices: { '1': 'grey' }, approval: null, note: 'hi' });
      const body = (await res.json()) as { card: { key: string; answerState: string; lastAnswer: { note: string } } };
      assert.equal(res.status, 200);
      assert.equal(body.card.key, 'o/r#5');
      assert.equal(body.card.answerState, 'awaiting-pickup');
      assert.equal(body.card.lastAnswer.note, 'hi');
    });
    it('answers 409 with the fresh card when the version is stale', async () => {
      await seedPaused(h);
      const res = await call(h, 'owner', 'POST', '/api/answer', { repo: 'o/r', number: 5, version: 99, choices: {}, approval: null, note: 'x' });
      const body = (await res.json()) as { error: string; card: { version: number } };
      assert.equal(res.status, 409);
      assert.match(body.error, /changed/);
      assert.equal(body.card.version, 1);
    });
    it('answers 409 to the second of two sends for one version', async () => {
      const rec = await seedPaused(h);
      const send = () => call(h, 'owner', 'POST', '/api/answer', { repo: 'o/r', number: 5, version: rec.version, choices: { '1': 'gold' }, approval: null, note: '' });
      assert.equal((await send()).status, 200);
      const second = await send();
      assert.equal(second.status, 409);
      assert.ok(((await second.json()) as { card: unknown }).card);
    });
  });

  describe('/api/board', () => {
    it('lists the cards', async () => {
      await seedPaused(h);
      const res = await call(h, 'owner', 'GET', '/api/board');
      const body = (await res.json()) as { waiting: { key: string }[] };
      assert.deepEqual(body.waiting.map((c) => c.key), ['o/r#5']);
    });
    it('ends a merged record and leaves it out', async () => {
      await seedPaused(h);
      h.items = [facts({ number: 5, merged: true, closedAt: NOW_ISO })];
      const res = await call(h, 'owner', 'GET', '/api/board');
      const body = (await res.json()) as { everything: unknown[] };
      assert.equal(body.everything.length, 0);
      assert.equal(await findWork(h.db, { repo: 'o/r', n: 5 } satisfies ItemRef), null);
      const row = await h.db.prepare('SELECT ended_how FROM work').first<{ ended_how: string }>();
      assert.equal(row?.ended_how, 'merged');
    });
    it('does not end a record whose facts were not read', async () => {
      await seedPaused(h);
      h.items = [];
      await call(h, 'owner', 'GET', '/api/board');
      assert.ok(await findWork(h.db, { repo: 'o/r', n: 5 }));
    });
    it('queues labels only when the facts are fresh', async () => {
      await seedPaused(h);
      await Promise.all(h.waiting);
      h.labelCalls.length = 0;
      h.waiting.length = 0;
      h.fromCache = true;
      await call(h, 'owner', 'GET', '/api/board');
      assert.equal(h.waiting.length, 0);
      h.fromCache = false;
      await call(h, 'owner', 'GET', '/api/board');
      await Promise.all(h.waiting);
      assert.equal(h.labelCalls.length, 1);
    });
  });

  describe("Claude's routes", () => {
    it('/api/ok confirms the status', async () => {
      await seedPaused(h);
      const res = await call(h, 'claude', 'POST', '/api/ok', { repo: 'o/r', number: 5 });
      const body = (await res.json()) as { record: { confirmedAt: string } };
      assert.equal(body.record.confirmedAt, NOW_ISO);
    });
    it('/api/work finds the record and its answers, or 404', async () => {
      const rec = await seedPaused(h);
      await call(h, 'owner', 'POST', '/api/answer', { repo: 'o/r', number: 5, version: rec.version, choices: { '1': 'gold' }, approval: null, note: '' });
      const res = await call(h, 'claude', 'GET', '/api/work?repo=o/r&number=5');
      const body = (await res.json()) as { record: { version: number }; answers: unknown[] };
      assert.equal(body.answers.length, 1);
      assert.equal((await call(h, 'claude', 'GET', '/api/work?repo=o/r&number=9')).status, 404);
    });
    it('lists unclaimed answers by ref or by age, and claims them', async () => {
      const rec = await seedPaused(h);
      await call(h, 'owner', 'POST', '/api/answer', { repo: 'o/r', number: 5, version: rec.version, choices: { '1': 'gold' }, approval: null, note: '' });
      const byRef = (await (await call(h, 'claude', 'POST', '/api/unclaimed', { refs: [{ repo: 'o/r', number: 5 }] })).json()) as unknown[];
      assert.equal(byRef.length, 1);
      assert.equal(((await (await call(h, 'claude', 'POST', '/api/unclaimed', { olderThanMs: 60_000 })).json()) as unknown[]).length, 0);
      const claimed = (await (await call(h, 'claude', 'POST', '/api/claim', { repo: 'o/r', number: 5, by: 'service' })).json()) as { record: { state: string }; answers: { id: number }[] };
      assert.equal(claimed.record.state, 'working');
      const mine = (await (await call(h, 'claude', 'GET', '/api/service-claims')).json()) as unknown[];
      assert.equal(mine.length, 1);
      const ans = claimed.answers.map((a) => a.id);
      assert.equal((await call(h, 'claude', 'POST', '/api/gave-up', { answerIds: ans, hint: 'look at the log' })).status, 200);
      assert.equal(((await (await call(h, 'claude', 'GET', '/api/service-claims')).json()) as unknown[]).length, 0);
    });
    it('/api/unclaim puts the answers back', async () => {
      const rec = await seedPaused(h);
      await call(h, 'owner', 'POST', '/api/answer', { repo: 'o/r', number: 5, version: rec.version, choices: { '1': 'gold' }, approval: null, note: '' });
      const claimed = (await (await call(h, 'claude', 'POST', '/api/claim', { repo: 'o/r', number: 5, by: 'session' })).json()) as { answers: { id: number }[] };
      const res = await call(h, 'claude', 'POST', '/api/unclaim', { answerIds: claimed.answers.map((a) => a.id) });
      assert.deepEqual(await res.json(), {});
      const again = (await (await call(h, 'claude', 'POST', '/api/unclaimed', { refs: [{ repo: 'o/r', number: 5 }] })).json()) as unknown[];
      assert.equal(again.length, 1);
    });
    it('/api/import brings in a record, and refuses a repeat with 409', async () => {
      h.items = [facts({ number: 7 })];
      await setStatus(h.db, { repo: 'o/r', n: 8 }, { gate: 'implementation', state: 'working', ask: 'a', questions: [], toTest: null, reason: null, noDesign: true, headSha: null, isPr: true, issue: null, replaces: null }, NOW_ISO);
      const record = {
        issue: null, pr: 7, hasDesign: false, gate: 'implementation', state: 'working', reached: 'implementation', ask: 'Imported', questions: [],
        toTest: null, backReason: null, approved: {}, rounds: { design: 0, implementation: 0, prep: 0 }, prepSha: null, turnSince: NOW_ISO,
        writtenAt: NOW_ISO, startedAt: NOW_ISO,
      };
      const res = await call(h, 'claude', 'POST', '/api/import', { repo: 'o/r', number: 7, record });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { record: { ask: string } }).record.ask, 'Imported');
      assert.equal((await call(h, 'claude', 'POST', '/api/import', { repo: 'o/r', number: 7, record })).status, 409);
    });
  });
});
