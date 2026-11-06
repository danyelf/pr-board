import type { ItemFacts, Question, Status } from '../src/shared/types.ts';

export function facts(over: Partial<ItemFacts> = {}): ItemFacts {
  return {
    repo: 'danyelf/torahmap', number: 1, kind: 'pr', title: 't', url: 'https://github.com/danyelf/torahmap/pull/1',
    labels: [], body: '', createdAt: '2026-11-01T10:00:00-08:00', closedAt: null,
    isDraft: false, merged: false, mergedAt: null, mergeState: null, behindBase: false,
    linkedIssue: null, stackedOn: null, stackedOnOpen: false,
    previewUrl: null, addedDocs: [], screenshots: [],
    reviewSha: null, reviewUrl: null, commitsSinceReview: null,
    prepDone: false, commitsSincePrep: null, statusCommentBody: null, statusWrittenAt: null, lastChangeAt: null,
    labelEvents: [], lastActivityAt: '2026-11-01T10:00:00-08:00',
    ...over,
  };
}

export function status(over: Partial<Status> = {}, questionCount = 0): Status {
  const questions: Question[] = Array.from({ length: questionCount }, (_, i) => ({
    n: i + 1, text: `q${i + 1}`, choices: ['a', 'b'], defaultChoice: 'a',
  }));
  return { waitingOn: 'Danyel', since: '2026-11-04T09:00:00-08:00', ask: 'look', questions, toTest: null, ...over };
}
