import { readFileSync } from 'node:fs';
import { fetchItems } from '../src/worker/github.ts';
import { renderStatus } from '../src/shared/status.ts';
import type { ItemFacts } from '../src/shared/types.ts';
import { answerRepo } from './github-fake.ts';
import { status } from './helpers.ts';

export const NOW = new Date('2026-11-06T00:00:00Z');

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function fakeFetch(): typeof fetch {
  const items = fixture('graphql-items.json').data.r0;
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url === 'https://api.github.com/graphql') {
      const query: string = JSON.parse(init.body).query;
      if (query.includes('viewer')) return Response.json(fixture('graphql-repos.json'));
      const data: Record<string, any> = {};
      for (const m of query.matchAll(/(r\d+): repository\(/g)) data[m[1]!] = answerRepo(query, items);
      return Response.json({ data });
    }
    if (/\/compare\//.test(url)) return Response.json({ behind_by: 0 });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
}

/** The recorded items, edited so the board has something to say about each of them. */
export async function boardItems(): Promise<ItemFacts[]> {
  const { items } = await fetchItems('tok', NOW, fakeFetch());
  const get = (n: number) => items.find((i) => i.number === n)!;

  // The recording was made after these three merged. Wind them back to the moment the board is built for.
  for (const i of items) {
    i.activityTimes = i.activityTimes.filter((t) => Date.parse(t) <= NOW.getTime());
    i.lastActivityAt = i.activityTimes.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a), i.createdAt);
    i.labelEvents = i.labelEvents.filter((e) => Date.parse(e.at) <= NOW.getTime());
  }
  for (const n of [573, 574, 578]) {
    Object.assign(get(n), { merged: false, mergedAt: null, closedAt: null, mergeState: 'CLEAN' });
  }

  const section = (since: string, extra: Partial<ReturnType<typeof status>> = {}) =>
    renderStatus(status({ waitingOn: 'Danyel', since, ask: 'Take a look', ...extra }));

  const p573 = get(573);
  p573.body = `${section('2026-11-04T07:20:00Z')}\n\n${p573.body}`;
  p573.labels = ['on danyel'];
  p573.labelEvents.push({ label: 'on danyel', action: 'added', at: '2026-11-04T07:20:00Z' });

  const p574 = get(574);
  p574.body = `${section('2026-11-04T07:32:00Z', {
    questions: [{ n: 1, text: 'Should the popup follow the pointer?', choices: ['leave', 'change'], defaultChoice: 'leave' }],
  })}\n\n${p574.body}`;
  p574.labels = ['on danyel'];
  p574.labelEvents.push({ label: 'on danyel', action: 'added', at: '2026-11-04T07:32:00Z' });

  const p578 = get(578);
  p578.body = `${section('2026-11-05T23:39:00Z')}\n\n${p578.body}`;
  p578.labels = ['on danyel'];
  p578.labelEvents.push({ label: 'on danyel', action: 'added', at: '2026-11-05T23:39:00Z' });

  const p564 = get(564);
  p564.body = `${section('2026-11-05T12:00:00Z')}\n\n${p564.body}`;
  p564.labels = [];
  return items;
}
