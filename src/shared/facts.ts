/** The combined states GitHub gives the checks on a commit. */
export const CHECK_STATES = ['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED'] as const;

/** What GitHub says about a pull request or issue: the things the board does not keep itself. */
export interface Facts {
  repo: string;
  number: number;
  kind: 'pr' | 'issue';
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
  closedAt: string | null;
  merged: boolean;
  lastActivityAt: string;
  // The rest is for PRs; an issue has null, false or an empty list.
  isDraft: boolean;
  headSha: string | null;
  headRef: string | null;
  mergeState: string | null;
  reviewDecision: string | null;
  /** The combined state of the checks on the head commit; null when there are none. */
  checks: (typeof CHECK_STATES)[number] | null;
  behindBase: boolean;
  linkedIssue: number | null;
  stackedOn: number | null;
  stackedOnOpen: boolean;
  previewUrl: string | null;
  screenshots: string[];
}
