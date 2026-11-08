// Names and values several parts of the board have to agree on. Each lives here once.
import { OWNER_NAME } from './config.ts';

export const LABEL_ON_OWNER = `on ${OWNER_NAME.toLowerCase()}`;
export const LABEL_PARKED = 'parked';
export const LABEL_IN_PROGRESS = 'in-progress';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an answer may wait for a Claude session to claim it before the board says nobody has. */
export const PICKUP_GRACE_MS = 10 * 60 * 1000;

/** How long the Mac service waits before starting a session for an answer. It must stay below PICKUP_GRACE_MS. */
export const SERVICE_GRACE_MS = 5 * 60 * 1000;

/** The git config key that marks a repo whose sessions act as Claude's own GitHub account. */
export const CLAUDE_BOT_KEY = 'claude.bot';

/** The Worker and the label setup both cover repos pushed to within this many days. */
export const REPO_WINDOW_DAYS = 60;

/** Who a status can be waiting on. `role` is the code's name; `spelling` is how the status section writes it. */
export const WAITING_ON = [
  { role: 'owner', spelling: OWNER_NAME },
  { role: 'claude', spelling: 'Claude' },
  { role: 'nobody', spelling: 'nobody' },
] as const;

export type WaitingOn = (typeof WAITING_ON)[number]['role'];

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
