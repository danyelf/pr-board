import { describe, expect, it } from 'vitest';
import { stageStrip, whyTag } from '../src/shared/stage.ts';
import { facts, status } from './helpers.ts';

const now = new Date('2026-11-05T12:00:00-08:00');
const states = (f: ReturnType<typeof facts>, s: ReturnType<typeof status> | null) => stageStrip(f, s, now).map((b) => b.state);
const box = (f: ReturnType<typeof facts>, s: ReturnType<typeof status> | null, name: string) =>
  stageStrip(f, s, now).find((b) => b.name === name)!;

const pr573 = () => facts({
  number: 573, linkedIssue: 569,
  addedDocs: [{ path: 'docs/plans/2026-11-03-tools-state.md', url: 'https://github.com/danyelf/torahmap/pull/573/files' }],
  reviewSha: 'bd275212', commitsSinceReview: 1, labels: ['on danyel'], behindBase: true,
});

describe('stage strip', () => {
  it('always has the six stages in order', () => {
    expect(stageStrip(facts(), null, now).map((b) => b.name)).toEqual(
      ['Issue', 'Design', 'Build', 'Claude review', 'Your look', 'Merge']);
  });

  it('shows 573 as waiting on a look, with a rebase needed', () => {
    const f = pr573();
    const s = status({}, 0);
    expect(states(f, s)).toEqual(['done', 'done', 'done', 'done', 'now', 'todo']);
    expect(box(f, s, 'Issue').note).toBe('#569');
    expect(box(f, s, 'Design').note).toBe('✓');
    expect(box(f, s, 'Claude review').note).toBe('✓ 1 commits since');
    expect(box(f, s, 'Your look').note).toBe('1 d 3 h');
    expect(box(f, s, 'Merge').note).toBe('rebase first');
    expect(whyTag(f, s, now)).toBe('Only your look is left');
  });

  it('shows 574 stacked on an open PR with two questions', () => {
    const f = facts({ number: 574, stackedOn: 573, stackedOnOpen: true, labels: ['on danyel'], linkedIssue: 570 });
    const s = status({}, 2);
    expect(box(f, s, 'Your look').note).toBe('2 questions');
    expect(box(f, s, 'Merge')).toEqual({ name: 'Merge', state: 'todo', note: 'after #573' });
    expect(whyTag(f, s, now)).toBe('2 decisions + your look');
  });

  describe('578 after prep', () => {
    const f = (over = {}) => facts({
      number: 578, linkedIssue: 571, reviewSha: 'abc', prepDone: true, commitsSincePrep: 0,
      labels: ['on danyel'], mergeState: 'CLEAN', ...over,
    });
    it('is ready to merge', () => {
      expect(states(f(), status())).toEqual(['done', 'todo', 'done', 'done', 'done', 'ready']);
      expect(whyTag(f(), status(), now)).toBe('Ready to merge');
    });
    it('is blocked by failing checks', () => {
      expect(box(f({ mergeState: 'UNSTABLE' }), status(), 'Merge')).toMatchObject({ state: 'blocked', note: 'checks failing' });
      expect(whyTag(f({ mergeState: 'UNSTABLE' }), status(), now)).toBe("Can't merge yet: checks failing");
    });
    it('is blocked by being a draft', () => {
      expect(box(f({ isDraft: true }), status(), 'Merge')).toMatchObject({ state: 'blocked', note: 'draft' });
    });
    it('names the other blockers', () => {
      expect(box(f({ stackedOn: 1, stackedOnOpen: true }), status(), 'Merge').note).toBe('after #1');
      expect(box(f({ mergeState: 'DIRTY' }), status(), 'Merge').note).toBe('conflicts');
      expect(box(f({ mergeState: 'BLOCKED' }), status(), 'Merge').note).toBe('checks failing');
      expect(box(f({ mergeState: 'BEHIND' }), status(), 'Merge').note).toBe('rebase first');
      expect(box(f({ behindBase: true }), status(), 'Merge').note).toBe('rebase first');
      expect(box(f({ commitsSincePrep: 2 }), status(), 'Merge').note).toBe('commits since prep');
      expect(box(f({ mergeState: 'UNKNOWN' }), status(), 'Merge').note).toBe('GitHub still checking');
    });
  });

  it('counts commits since prep instead of since review once prep is done', () => {
    const f = facts({ reviewSha: 'x', commitsSinceReview: 5, prepDone: true, commitsSincePrep: 2 });
    expect(box(f, null, 'Claude review').note).toBe('✓ 2 commits since');
    expect(box(facts({ prepDone: true, commitsSincePrep: 0 }), null, 'Claude review').note).toBe('✓ prep done');
    expect(box(facts({ reviewSha: 'x', commitsSinceReview: 0 }), null, 'Claude review').note).toBe('✓');
    expect(box(facts(), null, 'Claude review').state).toBe('todo');
  });

  it('shows an issue with no PR waiting on Danyel at Design', () => {
    const f = facts({ kind: 'issue', number: 569, labels: ['on danyel'] });
    expect(states(f, null)).toEqual(['done', 'now', 'todo', 'todo', 'now', 'todo']);
    expect(box(f, null, 'Issue').note).toBe('#569');
  });

  it('shows a PR with no linked issue and mockups', () => {
    const f = facts({ screenshots: ['a.png', 'b.png'] });
    expect(box(f, null, 'Issue')).toMatchObject({ state: 'todo', note: '' });
    expect(box(f, null, 'Design')).toMatchObject({ state: 'done', note: '2 mockups' });
  });

  it('marks everything done on a merged PR', () => {
    const f = facts({ merged: true, reviewSha: 'x' });
    const s = states(f, null);
    expect(s[4]).toBe('done');
    expect(s[5]).toBe('done');
  });

  it('says Parked for a parked item', () => {
    expect(whyTag(facts({ labels: ['parked'] }), null, now)).toBe('Parked');
    expect(whyTag(facts({ labels: ['in-progress'] }), null, now)).toBe('');
  });
});
