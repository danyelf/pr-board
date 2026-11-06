import { describe, expect, it } from 'vitest';
import { effectiveTurn, formatWait, isReadyToMerge, turnOf, waitingSince } from '../src/shared/turn.ts';
import { facts, status } from './helpers.ts';

describe('turnOf', () => {
  it('reads whose turn it is from labels', () => {
    expect(turnOf(['on danyel', 'in-progress'])).toBe('danyel');
    expect(turnOf(['parked', 'in-progress'])).toBe('nobody');
    expect(turnOf(['in-progress'])).toBe('claude');
    expect(turnOf([])).toBe('none');
  });
});

describe('effectiveTurn', () => {
  it('treats the item as Danyel\'s when the status says so but labels do not', () => {
    expect(effectiveTurn(['in-progress'], status({ waitingOn: 'Danyel' }))).toEqual({ turn: 'danyel', outOfSync: true });
  });
  it('flags a label that disagrees with the status', () => {
    expect(effectiveTurn(['on danyel'], status({ waitingOn: 'Claude' }))).toEqual({ turn: 'danyel', outOfSync: true });
  });
  it('flags a status that says Danyel when there is no turn label at all', () => {
    expect(effectiveTurn([], status({ waitingOn: 'Danyel' }))).toEqual({ turn: 'danyel', outOfSync: true });
  });
  it('is in sync with no status', () => {
    expect(effectiveTurn(['on danyel'], null)).toEqual({ turn: 'danyel', outOfSync: false });
  });
  it('is in sync when they agree, and no turn label never counts as a disagreement', () => {
    expect(effectiveTurn(['in-progress'], status({ waitingOn: 'Claude' }))).toEqual({ turn: 'claude', outOfSync: false });
    expect(effectiveTurn([], status({ waitingOn: 'Claude' }))).toEqual({ turn: 'none', outOfSync: false });
  });
});

describe('waitingSince', () => {
  it('prefers the label event over a stale status time', () => {
    const f = facts({
      labels: ['on danyel'],
      labelEvents: [{ label: 'on danyel', action: 'added', at: '2026-11-04T15:00:00-08:00' }],
    });
    expect(waitingSince(f, status({ since: '2026-11-01T09:00:00-08:00' }))).toBe('2026-11-04T15:00:00-08:00');
  });
  it('ignores an added event that was later removed, and uses the latest one in force', () => {
    const f = facts({
      labels: ['on danyel'],
      labelEvents: [
        { label: 'on danyel', action: 'added', at: '2026-11-02T10:00:00-08:00' },
        { label: 'on danyel', action: 'removed', at: '2026-11-02T11:00:00-08:00' },
        { label: 'on danyel', action: 'added', at: '2026-11-03T10:00:00-08:00' },
      ],
    });
    expect(waitingSince(f, null)).toBe('2026-11-03T10:00:00-08:00');
    const removed = facts({
      labelEvents: [
        { label: 'on danyel', action: 'added', at: '2026-11-02T10:00:00-08:00' },
        { label: 'on danyel', action: 'removed', at: '2026-11-02T11:00:00-08:00' },
      ],
    });
    expect(waitingSince(removed, status({ since: '2026-11-01T09:00:00-08:00' }))).toBe('2026-11-01T09:00:00-08:00');
  });
  it('falls back to status.since, then null', () => {
    expect(waitingSince(facts({ labels: ['on danyel'] }), status({ since: '2026-11-01T09:00:00-08:00' }))).toBe('2026-11-01T09:00:00-08:00');
    expect(waitingSince(facts(), null)).toBeNull();
  });
});

describe('formatWait', () => {
  const now = new Date('2026-11-05T12:00:00-08:00');
  it('uses minutes, hours, then days and hours', () => {
    expect(formatWait('2026-11-05T11:15:00-08:00', now)).toBe('45 min');
    expect(formatWait('2026-11-05T07:30:00-08:00', now)).toBe('4 h');
    expect(formatWait('2026-11-03T20:00:00-08:00', now)).toBe('1 d 16 h');
  });
  it('says nothing for a date it cannot read', () => {
    expect(formatWait('yesterday', now)).toBe('');
    expect(formatWait('', now)).toBe('');
  });
});

describe('isReadyToMerge', () => {
  const ready = () => facts({
    prepDone: true, commitsSincePrep: 0, labels: ['on danyel'], mergeState: 'CLEAN',
  });
  it('is true when everything lines up', () => {
    expect(isReadyToMerge(ready(), status())).toBe(true);
    expect(isReadyToMerge({ ...ready(), mergeState: 'HAS_HOOKS' }, null)).toBe(true);
  });
  it.each([
    ['draft', { isDraft: true }],
    ['merged', { merged: true }],
    ['commits since prep', { commitsSincePrep: 2 }],
    ['behind base', { behindBase: true }],
    ['stacked on open', { stackedOnOpen: true }],
    ['failing checks', { mergeState: 'UNSTABLE' }],
    ['no prep', { prepDone: false }],
    ['not a PR', { kind: 'issue' as const }],
    ['not Danyel\'s turn', { labels: ['in-progress'] }],
  ])('is false when %s', (_n, over) => {
    expect(isReadyToMerge({ ...ready(), ...over }, null)).toBe(false);
  });
  it('is false with open questions', () => {
    expect(isReadyToMerge(ready(), status({}, 1))).toBe(false);
  });
});
