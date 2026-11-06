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

  it('shows only the PR while an open PR stands for an issue', () => {
    const issue = facts({ number: 10, kind: 'issue', labels: ['in-progress'], lastActivityAt: '2026-11-05T20:00:00Z' });
    const pr = facts({ number: 11, linkedIssue: 10, labels: ['in-progress'], createdAt: '2026-11-05T10:00:00Z', lastActivityAt: '2026-11-05T21:00:00Z' });
    const board = buildBoard([issue, pr], [], NOW);
    expect(board.onClaude.map((c) => c.facts.number)).toEqual([11]);
  });

  it('keeps an open issue waiting on Danyel when the PR that refers to it has merged', () => {
    const issue = facts({ number: 10, kind: 'issue', labels: ['on danyel'], createdAt: '2026-11-05T09:00:00Z', lastActivityAt: '2026-11-05T20:00:00Z' });
    const pr = facts({ number: 11, linkedIssue: 10, merged: true, mergedAt: '2026-11-05T21:00:00Z', closedAt: '2026-11-05T21:00:00Z', createdAt: '2026-11-05T10:00:00Z' });
    const board = buildBoard([issue, pr], [], NOW);
    expect(board.waiting.map((c) => c.facts.number)).toEqual([10]);
  });

  it("carries a hidden issue's wait onto its open PR, flagged out of sync", () => {
    const issue = facts({
      number: 10, kind: 'issue', labels: ['on danyel'], lastActivityAt: '2026-11-05T20:00:00Z',
      labelEvents: [{ label: 'on danyel', action: 'added', at: '2026-11-05T12:00:00Z' }],
    });
    const pr = facts({ number: 11, linkedIssue: 10, labels: ['in-progress'], createdAt: '2026-11-05T10:00:00Z', lastActivityAt: '2026-11-05T21:00:00Z' });
    const board = buildBoard([issue, pr], [], NOW);
    expect(board.waiting.map((c) => c.facts.number)).toEqual([11]);
    const card = board.waiting[0]!;
    expect(card.turn).toBe('danyel');
    expect(card.outOfSync).toBe(true);
    expect(card.waitingSince).toBe('2026-11-05T12:00:00Z');
    expect(card.why).toBe('Issue #10 is waiting on you');
    expect([...board.onClaude, ...board.quiet]).toEqual([]);
  });

  it("carries an issue's wait when only its status comment says so", () => {
    const issue = facts({
      number: 10, kind: 'issue', labels: [], lastActivityAt: '2026-11-05T20:00:00Z',
      statusCommentBody: renderStatus(status({ waitingOn: 'Danyel', since: '2026-11-05T13:00:00Z' })),
    });
    const pr = facts({ number: 11, linkedIssue: 10, createdAt: '2026-11-05T10:00:00Z', lastActivityAt: '2026-11-05T21:00:00Z' });
    const board = buildBoard([issue, pr], [], NOW);
    expect(board.waiting.map((c) => c.facts.number)).toEqual([11]);
    expect(board.waiting[0]!.outOfSync).toBe(true);
  });

  it('does not flag the PR when it already says it is waiting on Danyel', () => {
    const issue = facts({ number: 10, kind: 'issue', labels: ['on danyel'], lastActivityAt: '2026-11-05T20:00:00Z' });
    const pr = facts({
      number: 11, linkedIssue: 10, labels: ['on danyel'], createdAt: '2026-11-05T10:00:00Z', lastActivityAt: '2026-11-05T21:00:00Z',
      labelEvents: [{ label: 'on danyel', action: 'added', at: '2026-11-05T15:00:00Z' }],
    });
    const board = buildBoard([issue, pr], [], NOW);
    const card = board.waiting[0]!;
    expect(card.facts.number).toBe(11);
    expect(card.outOfSync).toBe(false);
    expect(card.waitingSince).toBe('2026-11-05T15:00:00Z');
    expect(card.why).toBe('Needs your look');
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

  describe('a status older than the latest change', () => {
    const body = renderStatus(status({ waitingOn: 'Danyel' }));
    const stale = (over: Partial<ReturnType<typeof facts>>) =>
      buildBoard([facts({ number: 30, labels: ['on danyel'], body, lastActivityAt: '2026-11-05T23:00:00Z', ...over })], [], NOW).waiting[0]!.statusStale;

    it('is flagged when a commit or comment came after the status was written', () => {
      expect(stale({ statusWrittenAt: '2026-11-05T10:00:00Z', lastChangeAt: '2026-11-05T12:00:00Z' })).toBe(true);
    });
    it('is not flagged when the status is newer, or the same age', () => {
      expect(stale({ statusWrittenAt: '2026-11-05T12:00:00Z', lastChangeAt: '2026-11-05T10:00:00Z' })).toBe(false);
      expect(stale({ statusWrittenAt: '2026-11-05T12:00:00Z', lastChangeAt: '2026-11-05T12:00:00Z' })).toBe(false);
    });
    it('is not flagged when either time is unknown', () => {
      expect(stale({ statusWrittenAt: null, lastChangeAt: '2026-11-05T12:00:00Z' })).toBe(false);
      expect(stale({ statusWrittenAt: '2026-11-05T10:00:00Z', lastChangeAt: null })).toBe(false);
    });
    it('is not flagged when there is no status', () => {
      expect(stale({ body: '', statusWrittenAt: '2026-11-05T10:00:00Z', lastChangeAt: '2026-11-05T12:00:00Z' })).toBe(false);
    });
  });

  it('puts a status whose "since" is not a date last, with no waiting time', () => {
    const odd = facts({
      number: 40, labels: ['on danyel'], lastActivityAt: '2026-11-05T23:00:00Z',
      body: '<!-- status -->\n**Waiting on:** Danyel, since yesterday\n**Ask:** look\n<!-- /status -->',
    });
    const dated = facts({
      number: 41, labels: ['on danyel'], lastActivityAt: '2026-11-05T23:00:00Z',
      labelEvents: [{ label: 'on danyel', action: 'added', at: '2026-11-05T10:00:00Z' }],
    });
    const board = buildBoard([odd, dated], [], NOW);
    expect(board.waiting.map((c) => c.facts.number)).toEqual([41, 40]);
    expect(board.waiting[1]!.waited).toBe('');
  });

  it('passes errors and the time through', async () => {
    const board = buildBoard(await boardItems(), ['oops'], NOW);
    expect(board.errors).toEqual(['oops']);
    expect(board.generatedAt).toBe(NOW.toISOString());
  });
});
