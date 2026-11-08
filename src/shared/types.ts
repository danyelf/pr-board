import type { WaitingOn } from './names.ts';

/** Whose turn an item is: someone a status can wait on, or 'none' when nothing says. */
export type Turn = WaitingOn | 'none';
export interface Question { n: number; text: string; choices: string[]; defaultChoice: string | null }
export interface Status {
  waitingOn: WaitingOn;
  since: string | null;          // ISO 8601 with offset
  ask: string;
  questions: Question[];
  toTest: string | null;
}
export interface LabelEvent { label: string; action: 'added' | 'removed'; at: string }
export interface ItemFacts {
  repo: string; number: number; kind: 'pr' | 'issue'; title: string; url: string;
  labels: string[]; body: string; createdAt: string; closedAt: string | null;
  isDraft: boolean; merged: boolean; mergedAt: string | null;
  mergeState: string | null;          // GitHub mergeStateStatus, PRs only
  behindBase: boolean;                // PR head is missing commits from its base branch
  linkedIssue: number | null; stackedOn: number | null; stackedOnOpen: boolean;
  previewUrl: string | null; addedDocs: { path: string; url: string }[]; screenshots: string[];
  reviewSha: string | null; reviewUrl: string | null; commitsSinceReview: number | null;
  prepDone: boolean; commitsSincePrep: number | null;
  statusCommentBody: string | null;   // issues only
  statusWrittenAt: string | null;     // when the status was last written: a PR's description edit, or the issue's status comment
  lastChangeAt: string | null;        // latest commit or comment, not counting the issue's status comment
  labelEvents: LabelEvent[];
  lastActivityAt: string;             // latest of commits, comments, label changes, created/merged/closed
}
export type BoxState = 'done' | 'now' | 'ready' | 'blocked' | 'todo';
export interface StageBox { name: 'Issue' | 'Design' | 'Build' | 'Your look' | 'Prep' | 'Ready for merge'; state: BoxState; note: string }
