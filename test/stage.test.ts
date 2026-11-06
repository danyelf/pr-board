import { describe, expect, it } from 'vitest';
import { boxNamed, stageStrip, whyTag } from '../src/shared/stage.ts';
import { effectiveTurn } from '../src/shared/turn.ts';
import type { StageBox } from '../src/shared/types.ts';
import { facts, status } from './helpers.ts';

const now = new Date('2026-11-05T12:00:00-08:00');
const states = (f: ReturnType<typeof facts>, s: ReturnType<typeof status> | null) => stageStrip(f, s, now).map((b) => b.state);
const box = (f: ReturnType<typeof facts>, s: ReturnType<typeof status> | null, name: StageBox['name']) =>
  boxNamed(stageStrip(f, s, now), name);
const why = (f: ReturnType<typeof facts>, s: ReturnType<typeof status> | null) =>
  whyTag(s, stageStrip(f, s, now), effectiveTurn(f.labels, s).turn);

const pr573 = () => facts({
  number: 573, linkedIssue: 569,
  addedDocs: [{ path: 'docs/plans/2026-11-03-tools-state.md', url: 'https://github.com/danyelf/torahmap/pull/573/files' }],
  reviewSha: 'bd275212', commitsSinceReview: 1, labels: ['on danyel'], behindBase: true,
});

describe('stage strip', () => {
  it('always has the six stages in order', () => {
    expect(stageStrip(facts(), null, now).map((b) => b.name)).toEqual(
      ['Issue', 'Design', 'Build', 'Your look', 'Prep', 'Ready for merge']);
  });

  it('shows 573 as waiting on a look, with a rebase needed', () => {
    const f = pr573();
    const s = status({}, 0);
    expect(states(f, s)).toEqual(['done', 'done', 'done', 'now', 'todo', 'todo']);
    expect(box(f, s, 'Issue').note).toBe('#569');
    expect(box(f, s, 'Design').note).toBe('✓');
    expect(box(f, s, 'Build').note).toBe('✓ reviewed, 1 commit since');
    expect(box(f, s, 'Your look').note).toBe('');
    expect(box(f, s, 'Ready for merge').note).toBe('rebase first');
    expect(why(f, s)).toBe('Needs your look');
  });

  it('shows 574 stacked on an open PR with two questions', () => {
    const f = facts({ number: 574, stackedOn: 573, stackedOnOpen: true, labels: ['on danyel'], linkedIssue: 570 });
    const s = status({}, 2);
    expect(box(f, s, 'Your look').note).toBe('2 questions');
    expect(box(f, s, 'Ready for merge')).toEqual({ name: 'Ready for merge', state: 'todo', note: 'after #573' });
    expect(why(f, s)).toBe('2 decisions + your look');
  });

  it('says one question and one decision in the singular', () => {
    const f = facts({ number: 575, labels: ['on danyel'] });
    const s = status({}, 1);
    expect(box(f, s, 'Your look').note).toBe('1 question');
    expect(why(f, s)).toBe('1 decision + your look');
  });

  describe('578 after prep', () => {
    const f = (over = {}) => facts({
      number: 578, linkedIssue: 571, reviewSha: 'abc', prepDone: true, commitsSincePrep: 0,
      labels: ['on danyel'], mergeState: 'CLEAN', ...over,
    });
    it('is ready to merge', () => {
      expect(states(f(), status())).toEqual(['done', 'todo', 'done', 'done', 'done', 'ready']);
      expect(why(f(), status())).toBe('Ready to merge');
    });
    it('is blocked by failing checks', () => {
      expect(box(f({ mergeState: 'UNSTABLE' }), status(), 'Ready for merge')).toMatchObject({ state: 'blocked', note: 'checks failing' });
      expect(why(f({ mergeState: 'UNSTABLE' }), status())).toBe("Can't merge yet: checks failing");
    });
    it('is blocked by being a draft', () => {
      expect(box(f({ isDraft: true }), status(), 'Ready for merge')).toMatchObject({ state: 'blocked', note: 'draft' });
    });
    it('names the other blockers', () => {
      expect(box(f({ stackedOn: 1, stackedOnOpen: true }), status(), 'Ready for merge').note).toBe('after #1');
      expect(box(f({ mergeState: 'DIRTY' }), status(), 'Ready for merge').note).toBe('conflicts');
      expect(box(f({ mergeState: 'BLOCKED' }), status(), 'Ready for merge').note).toBe('checks failing');
      expect(box(f({ mergeState: 'BEHIND' }), status(), 'Ready for merge').note).toBe('rebase first');
      expect(box(f({ behindBase: true }), status(), 'Ready for merge').note).toBe('rebase first');
      expect(box(f({ commitsSincePrep: 2 }), status(), 'Ready for merge').note).toBe('commits since prep');
      expect(box(f({ mergeState: 'UNKNOWN' }), status(), 'Ready for merge').note).toBe('GitHub still checking');
    });
  });

  it('shows an early code review as a note on Build', () => {
    expect(box(facts({ reviewSha: 'x', commitsSinceReview: 0 }), null, 'Build').note).toBe('✓ reviewed');
    expect(box(facts({ reviewSha: 'x', commitsSinceReview: 2 }), null, 'Build').note).toBe('✓ reviewed, 2 commits since');
    expect(box(facts(), null, 'Build').note).toBe('✓');
  });

  it('does not call a review current when the reviewed commit is no longer in the PR', () => {
    expect(box(facts({ reviewSha: 'x', commitsSinceReview: null }), null, 'Build').note).toBe('✓ reviewed before a rebase');
  });

  it('marks Prep done once prep for merge has run, counting commits since', () => {
    expect(box(facts({ prepDone: true, commitsSincePrep: 0 }), null, 'Prep')).toMatchObject({ state: 'done', note: '✓' });
    expect(box(facts({ prepDone: true, commitsSincePrep: 2 }), null, 'Prep').note).toBe('✓ 2 commits since');
    expect(box(facts({ reviewSha: 'x' }), null, 'Prep').state).toBe('todo');
  });

  it('puts your look before prep: a PR waiting on Danyel with no prep yet', () => {
    expect(states(facts({ labels: ['on danyel'] }), status({}, 0))).toEqual(['todo', 'todo', 'done', 'now', 'todo', 'todo']);
  });

  it('shows an issue with no PR waiting on Danyel at Design', () => {
    const f = facts({ kind: 'issue', number: 569, labels: ['on danyel'] });
    expect(states(f, null)).toEqual(['done', 'now', 'todo', 'now', 'todo', 'todo']);
    expect(box(f, null, 'Issue').note).toBe('#569');
  });

  it('shows a PR with no linked issue and mockups', () => {
    const f = facts({ screenshots: ['a.png', 'b.png'] });
    expect(box(f, null, 'Issue')).toMatchObject({ state: 'todo', note: '' });
    expect(box(f, null, 'Design')).toMatchObject({ state: 'done', note: '2 mockups' });
  });

  it('marks everything done on a merged PR', () => {
    const f = facts({ merged: true, reviewSha: 'x' });
    expect(box(f, null, 'Your look').state).toBe('done');
    expect(box(f, null, 'Ready for merge').state).toBe('done');
  });

  it('says Parked for a parked item', () => {
    expect(why(facts({ labels: ['parked'] }), null)).toBe('Parked');
    expect(why(facts({ labels: ['in-progress'] }), null)).toBe('');
  });
});
