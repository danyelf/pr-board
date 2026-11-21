// Builders for the board view's tests, and the four cards sketched in the design.
import type { Facts } from '../src/shared/facts.ts';
import type { AnswerRow, WorkRecord } from '../src/shared/work.ts';

export const NOW = new Date('2026-11-20T12:00:00.000Z');

/** A time the given number of minutes before NOW. */
export function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}

export function record(over: Partial<WorkRecord> = {}): WorkRecord {
  return {
    id: 1, repo: 'o/r', issue: null, pr: 5, hasDesign: true, gate: 'implementation', state: 'working', reached: 'implementation',
    ask: 'Building it', questions: [], toTest: null, backReason: null, approved: { design: ago(600) },
    rounds: { design: 1, implementation: 0, prep: 0 }, prepSha: null,
    version: 3, turnSince: ago(120), writtenAt: ago(120), confirmedAt: null, startedAt: ago(2000), endedAt: null, endedHow: null,
    ...over,
  };
}

export function facts(over: Partial<Facts> = {}): Facts {
  const repo = over.repo ?? 'o/r';
  const number = over.number ?? 5;
  const kind = over.kind ?? 'pr';
  return {
    repo, number, kind, title: `Item ${number}`,
    url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    labels: [], createdAt: ago(3000), closedAt: null, merged: false, lastActivityAt: ago(30),
    isDraft: false, headSha: kind === 'pr' ? 'head1' : null, headRef: kind === 'pr' ? 'branch' : null,
    mergeState: kind === 'pr' ? 'CLEAN' : null, reviewDecision: null, checks: kind === 'pr' ? 'SUCCESS' : null,
    behindBase: false, linkedIssue: null, stackedOn: null, stackedOnOpen: false, previewUrl: null, screenshots: [],
    ...over,
  };
}

export function answer(over: Partial<AnswerRow> = {}): AnswerRow {
  return {
    id: 1, workId: 1, version: 3, at: ago(2), choices: {}, approval: null, note: 'a note',
    claimedAt: null, claimedBy: null, stateBefore: null, gaveUpAt: null,
    ...over,
  };
}

const TORAHMAP = 'acme/torahmap';

/** #626 Tools state: prep complete on the commit prep finished on, and GitHub says it can merge. */
export const toolsState = {
  record: record({
    id: 626, repo: TORAHMAP, pr: 626, gate: 'prep', state: 'complete', reached: 'prep', ask: 'Ready to merge',
    approved: { design: ago(3000), implementation: ago(1000) }, rounds: { design: 1, implementation: 1, prep: 1 },
    prepSha: 'abc626', turnSince: ago(180), startedAt: ago(5000),
  }),
  facts: facts({ repo: TORAHMAP, number: 626, title: 'Tools state', headSha: 'abc626', mergeState: 'CLEAN', checks: 'SUCCESS' }),
};

/** #573 Pinned verses: Claude paused in Implementation with one question. */
export const pinnedVerses = {
  record: record({
    id: 573, repo: TORAHMAP, pr: 573, gate: 'implementation', state: 'paused', reached: 'implementation', ask: 'One thing to decide',
    questions: [{ n: 1, text: 'Pin colour?', choices: ['gold', 'grey'], defaultChoice: 'gold' }],
    turnSince: ago(120), startedAt: ago(4000),
  }),
  facts: facts({ repo: TORAHMAP, number: 573, title: 'Pinned verses' }),
};

/** #580 Search box: Design complete for the second time. */
export const searchBox = {
  record: record({
    id: 580, repo: TORAHMAP, pr: null, issue: 580, gate: 'design', state: 'complete', reached: 'design', ask: 'Two mockups to pick from',
    approved: {}, rounds: { design: 2, implementation: 0, prep: 0 }, turnSince: ago(1440), startedAt: ago(3000),
  }),
  facts: facts({ repo: TORAHMAP, number: 580, kind: 'issue', title: 'Search box' }),
};

/** #564 Layout: reopened from Implementation back to Design, with Implementation on hold. */
export const layout = {
  record: record({
    id: 564, repo: TORAHMAP, pr: 564, gate: 'design', state: 'working', reached: 'implementation', ask: 'Redoing the grid',
    approved: {}, rounds: { design: 1, implementation: 0, prep: 0 }, backReason: "the grid can't hold long titles",
    turnSince: ago(60), startedAt: ago(6000),
  }),
  facts: facts({ repo: TORAHMAP, number: 564, title: 'Layout' }),
};
