// Names and values several parts of the board have to agree on. Each lives here once.
import { OWNER_NAME } from './config.ts';

export const LABEL_ON_OWNER = `on ${OWNER_NAME.toLowerCase()}`;
export const LABEL_PARKED = 'parked';
export const LABEL_IN_PROGRESS = 'in-progress';
export const LABEL_GATE_DESIGN = 'gate: design';
export const LABEL_GATE_IMPLEMENTATION = 'gate: implementation';
export const LABEL_GATE_PREP = 'gate: prep';
export const LABEL_READY_TO_MERGE = 'ready to merge';

/** Means: go with the default, and file the question as a new issue to decide later. */
export const FILE_AN_ISSUE = 'file an issue';

// The asks written by code rather than by a session, so the board and the service can tell them apart.
/** Written as an answer is claimed by a session, before it is woken. */
export const WORKING_ASK = 'Working on your answers';
/** Written when the Mac service claims an answer and starts a session for it. */
export const SERVICE_WORKING_ASK = 'A Mac session is working on your answers';
/** Written when that session ended without handing the item on; it hands it to the owner. */
export const GAVE_UP_ASK = 'A Mac session gave up on your answers';

/** The longest note an answer may carry. */
export const NOTE_MAX = 2000;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an answer may wait for a Claude session to claim it before the board says nobody has. */
export const PICKUP_GRACE_MS = 10 * 60 * 1000;

/** How long the Mac service lets a session run, unless its config says otherwise. */
export const SESSION_LIMIT_MS = 60 * 60 * 1000;

/**
 * How long the watcher's "Working on your answers" may stand unchanged before the board says nothing
 * has happened since the pickup: as long as a session the Mac service starts may run.
 */
export const WORKING_STALLS_MS = SESSION_LIMIT_MS;

/** How long the Mac service waits before starting a session for an answer. It must stay below PICKUP_GRACE_MS. */
export const SERVICE_GRACE_MS = 5 * 60 * 1000;

/** The git config key that marks a repo whose sessions act as Claude's own GitHub account. */
export const CLAUDE_BOT_KEY = 'claude.bot';

/** The Worker and the label setup both cover repos pushed to within this many days. */
export const REPO_WINDOW_DAYS = 60;

/**
 * Text that other tools write, and that the board looks for. If one of them changes its wording,
 * the board stops seeing it, so the wording is kept here, together, with who writes it.
 */
export const WRITTEN_ELSEWHERE = {
  /** Cloudflare's preview comment on a PR. The capture is the preview address. */
  previewLink: /href='(https:\/\/[^']+)'>Branch Preview URL/,
  /** A line in a PR description, written by Claude, naming the issue the PR is about. */
  refsIssue: /Refs #(\d+)/,
  /** A line in a PR description, written by Claude, naming the PR this one is built on. */
  stackedOn: /Stacked on #(\d+)/i,
};
