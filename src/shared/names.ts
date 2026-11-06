// Names and values several parts of the board have to agree on. Each lives here once.

export const LABEL_ON_DANYEL = 'on danyel';
export const LABEL_PARKED = 'parked';
export const LABEL_IN_PROGRESS = 'in-progress';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The Worker and the label setup both cover repos pushed to within this many days. */
export const REPO_WINDOW_DAYS = 60;

/**
 * The people a status can be waiting on. `status` is how the status section spells it, `option` is the
 * value of the command-line `--waiting` flag, and `turn` is whose turn it makes the item.
 */
export const WAITING_ON = [
  { status: 'Danyel', option: 'danyel', turn: 'danyel' },
  { status: 'Claude', option: 'claude', turn: 'claude' },
  { status: 'nobody', option: 'nobody', turn: 'nobody' },
] as const;

export type WaitingOn = (typeof WAITING_ON)[number]['status'];
export type WaitingOption = (typeof WAITING_ON)[number]['option'];

/**
 * Text that other tools write, and that the board looks for. If one of them changes its wording,
 * the board stops seeing it, so the wording is kept here, together, with who writes it.
 */
export const WRITTEN_ELSEWHERE = {
  /** Claude's code-review comment on a PR. The capture is the commit the review covered. */
  reviewedUpTo: /Reviewed up to `([0-9a-f]{7,40})`/,
  /** Claude's prep-for-merge comment on a PR. */
  prepForMerge: '🤖 Claude: prep for merge',
  /** Cloudflare's preview comment on a PR. The capture is the preview address. */
  previewLink: /href='(https:\/\/[^']+)'>Branch Preview URL/,
  /** A line in a PR description, written by Claude, naming the issue the PR is about. */
  refsIssue: /Refs #(\d+)/,
  /** A line in a PR description, written by Claude, naming the PR this one is built on. */
  stackedOn: /Stacked on #(\d+)/i,
  /** The heading Claude puts in a PR description above the steps for trying the change. */
  toLookAt: '**To look at on the preview:**',
};
