import type { BoxState, ItemFacts, StageBox, Status } from './types.ts';
import { effectiveTurn, formatWait, isReadyToMerge, waitingSince } from './turn.ts';

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function box(name: StageBox['name'], state: BoxState, note = ''): StageBox {
  return { name, state, note };
}

function mergeBox(f: ItemFacts, s: Status | null, turn: string, now: Date): StageBox {
  if (f.merged) return box('Ready for merge', 'done');
  if (isReadyToMerge(f, s)) {
    const since = waitingSince(f, s);
    return box('Ready for merge', 'ready', since ? formatWait(since, now) : '');
  }
  const stacked = f.stackedOnOpen && f.stackedOn !== null ? `after #${f.stackedOn}` : null;
  const rebase = f.behindBase || f.mergeState === 'BEHIND' ? 'rebase first' : null;
  const pastPrep = f.kind === 'pr' && f.prepDone && turn === 'danyel';
  const note = pastPrep
    ? (f.isDraft ? 'draft' : null) ??
      stacked ??
      (f.mergeState === 'DIRTY' ? 'conflicts' : null) ??
      (f.mergeState === 'UNSTABLE' || f.mergeState === 'BLOCKED' ? 'checks failing' : null) ??
      rebase ??
      ((f.commitsSincePrep ?? 0) > 0 ? 'commits since prep' : null) ??
      (f.mergeState === 'UNKNOWN' ? 'GitHub still checking' : null)
    : stacked ?? rebase;
  return box('Ready for merge', pastPrep && note ? 'blocked' : 'todo', note ?? '');
}

export function stageStrip(f: ItemFacts, s: Status | null, now: Date = new Date()): StageBox[] {
  const { turn } = effectiveTurn(f.labels, s);
  const isPr = f.kind === 'pr';
  const questions = s?.questions.length ?? 0;

  const issue = isPr
    ? f.linkedIssue !== null ? box('Issue', 'done', `#${f.linkedIssue}`) : box('Issue', 'todo')
    : box('Issue', 'done', `#${f.number}`);

  const design =
    f.addedDocs.length > 0 ? box('Design', 'done', '✓')
    : f.screenshots.length > 0 ? box('Design', 'done', `${f.screenshots.length} mockups`)
    : !isPr && turn === 'danyel' ? box('Design', 'now')
    : box('Design', 'todo');

  // A code review Claude posted before prep is a note on Build, not a stage of its own.
  const sinceReview = f.commitsSinceReview ?? 0;
  const build = !isPr ? box('Build', 'todo')
    : f.reviewSha === null ? box('Build', 'done', '✓')
    : sinceReview > 0 ? box('Build', 'done', `✓ reviewed, ${count(sinceReview, 'commit')} since`)
    : box('Build', 'done', '✓ reviewed');

  // Prep for merge runs after Danyel's look, once he says the PR looks good.
  const sincePrep = f.commitsSincePrep ?? 0;
  const prep = !f.prepDone ? box('Prep', 'todo')
    : sincePrep > 0 ? box('Prep', 'done', `✓ ${count(sincePrep, 'commit')} since`)
    : box('Prep', 'done', '✓');

  let look: StageBox;
  if (f.merged || f.prepDone) {
    look = box('Your look', 'done');
  } else if (turn === 'danyel') {
    // How long it has waited is already in the card's header, so the box only counts questions.
    look = box('Your look', 'now', questions > 0 ? count(questions, 'question') : '');
  } else {
    look = box('Your look', 'todo');
  }

  return [issue, design, build, look, prep, mergeBox(f, s, turn, now)];
}

export function whyTag(f: ItemFacts, s: Status | null, now: Date = new Date()): string {
  const strip = stageStrip(f, s, now);
  const merge = strip[5]!;
  const look = strip[3]!;
  const { turn } = effectiveTurn(f.labels, s);
  const questions = s?.questions.length ?? 0;
  if (merge.state === 'ready') return 'Ready to merge';
  if (merge.state === 'blocked') return `Can't merge yet: ${merge.note}`;
  if (questions > 0 && turn === 'danyel') return `${count(questions, 'decision')} + your look`;
  if (look.state === 'now') return 'Needs your look';
  if (turn === 'nobody') return 'Parked';
  return '';
}
