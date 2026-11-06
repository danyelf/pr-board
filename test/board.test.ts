import { describe, expect, it } from 'vitest';
import { renderStatus } from '../src/shared/status.ts';
import { buildBoard } from '../src/worker/board.ts';
import { facts, status } from './helpers.ts';
import { NOW, boardItems } from './board-items.ts';

describe('buildBoard', () => {
  it('puts what waits on Danyel first, oldest wait first', async () => {
    const board = buildBoard(await boardItems(), [], NOW);
    expect(board.waiting.map((c) => c.facts.number)).toEqual([573, 574, 564, 578]);
  });

  it('shows a label-less item whose status says Danyel as waiting and out of sync', async () => {
    const board = buildBoard(await boardItems(), [], NOW);
    const card = board.waiting.find((c) => c.facts.number === 564)!;
    expect(card.outOfSync).toBe(true);
    expect(card.turn).toBe('danyel');
  });

  it('computes waiting time from the on-danyel label', async () => {
    const board = buildBoard(await boardItems(), [], NOW);
    const c573 = board.waiting.find((c) => c.facts.number === 573)!;
    expect(c573.waitingSince).toBe('2026-11-04T07:20:00Z');
    expect(c573.waited).toBe('1 d 16 h');
    expect(c573.toTest).toMatch(/^search for a word, open the search panel/);
  });

  it('drops an issue when an open PR closes it', async () => {
    const board = buildBoard(await boardItems(), [], NOW);
    const all = [...board.waiting, ...board.onClaude, ...board.quiet];
    expect(all.find((c) => c.facts.number === 563)).toBeUndefined();
  });

  it('keeps merged items off the cards', async () => {
    const board = buildBoard(await boardItems(), [], NOW);
    const all = [...board.waiting, ...board.onClaude, ...board.quiet];
    expect(all.find((c) => c.facts.number === 576)).toBeUndefined();
  });

  it('sorts waiting by wait start, nulls last, ties by number', () => {
    const items = [
      facts({ number: 5, labels: ['on danyel'], lastActivityAt: '2026-11-05T23:00:00Z' }),
      facts({ number: 4, labels: ['on danyel'], labelEvents: [{ label: 'on danyel', action: 'added', at: '2026-11-05T10:00:00Z' }] }),
      facts({ number: 3, labels: ['on danyel'], labelEvents: [{ label: 'on danyel', action: 'added', at: '2026-11-05T10:00:00Z' }] }),
    ];
    const board = buildBoard(items, [], NOW);
    expect(board.waiting.map((c) => c.facts.number)).toEqual([3, 4, 5]);
    expect(board.waiting[2]!.waited).toBe('');
  });

  it('shows an unlabelled, recently active PR as on Claude with turn none', () => {
    const f = facts({ number: 7, lastActivityAt: '2026-11-05T23:00:00Z' });
    const board = buildBoard([f], [], NOW);
    expect(board.onClaude).toHaveLength(1);
    expect(board.onClaude[0]!.turn).toBe('none');
  });

  it('parks an in-progress PR that has been inactive for 4 days', () => {
    const f = facts({ number: 8, labels: ['in-progress'], lastActivityAt: '2026-11-02T00:00:00Z' });
    const board = buildBoard([f], [], NOW);
    expect(board.quiet.map((c) => c.facts.number)).toEqual([8]);
    expect(board.onClaude).toEqual([]);
  });

  it('puts a parked PR in quiet however recent it is', () => {
    const f = facts({ number: 9, labels: ['parked'], lastActivityAt: '2026-11-05T23:00:00Z' });
    expect(buildBoard([f], [], NOW).quiet).toHaveLength(1);
  });

  it('orders On Claude by most recent activity', () => {
    const a = facts({ number: 1, labels: ['in-progress'], lastActivityAt: '2026-11-05T10:00:00Z' });
    const b = facts({ number: 2, labels: ['in-progress'], lastActivityAt: '2026-11-05T20:00:00Z' });
    expect(buildBoard([a, b], [], NOW).onClaude.map((c) => c.facts.number)).toEqual([2, 1]);
  });

  it('keeps a card with no status, and reads an issue status from its comment', () => {
    const pr = facts({ number: 1, labels: ['in-progress'], lastActivityAt: '2026-11-05T20:00:00Z' });
    const issue = facts({
      number: 2, kind: 'issue', labels: ['in-progress'], lastActivityAt: '2026-11-05T21:00:00Z',
      statusCommentBody: renderStatus(status({ waitingOn: 'Claude', toTest: 'try it' })),
    });
    const board = buildBoard([pr, issue], [], NOW);
    expect(board.onClaude.find((c) => c.facts.number === 1)!.status).toBeNull();
    expect(board.onClaude.find((c) => c.facts.number === 2)!.toTest).toBe('try it');
  });

  it('passes errors and the time through, and builds a timeline', async () => {
    const board = buildBoard(await boardItems(), ['oops'], NOW);
    expect(board.errors).toEqual(['oops']);
    expect(board.generatedAt).toBe(NOW.toISOString());
    expect(board.timeline.lanes.length).toBeGreaterThan(0);
  });
});
