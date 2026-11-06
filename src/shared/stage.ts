import type { BoxState, ItemFacts, StageBox, Status } from './types.ts';
import { effectiveTurn, formatWait, isReadyToMerge, waitingSince } from './turn.ts';

function box(name: StageBox['name'], state: BoxState, note = ''): StageBox {
  return { name, state, note };
}

function mergeBox(f: ItemFacts, s: Status | null, turn: string, now: Date): StageBox {
  if (f.merged) return box('Merge', 'done');
  if (isReadyToMerge(f, s)) {
    const since = waitingSince(f, s);
    return box('Merge', 'ready', since ? formatWait(since, now) : '');
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
  return box('Merge', pastPrep && note ? 'blocked' : 'todo', note ?? '');
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

  const build = isPr ? box('Build', 'done', '✓') : box('Build', 'todo');

  const reviewed = f.reviewSha !== null || f.prepDone;
  const since = f.prepDone ? f.commitsSincePrep : f.commitsSinceReview;
  const review = !reviewed ? box('Claude review', 'todo')
    : (since ?? 0) > 0 ? box('Claude review', 'done', `✓ ${since} commits since`)
    : box('Claude review', 'done', f.prepDone ? '✓ prep done' : '✓');

  let look: StageBox;
  if (f.merged || f.prepDone) {
    look = box('Your look', 'done');
  } else if (turn === 'danyel') {
    const at = waitingSince(f, s);
    look = box('Your look', 'now', questions > 0 ? `${questions} questions` : at ? formatWait(at, now) : '');
  } else {
    look = box('Your look', 'todo');
  }

  return [issue, design, build, review, look, mergeBox(f, s, turn, now)];
}

export function whyTag(f: ItemFacts, s: Status | null, now: Date = new Date()): string {
  const strip = stageStrip(f, s, now);
  const merge = strip[5]!;
  const look = strip[4]!;
  const { turn } = effectiveTurn(f.labels, s);
  const questions = s?.questions.length ?? 0;
  if (merge.state === 'ready') return 'Ready to merge';
  if (merge.state === 'blocked') return `Can't merge yet: ${merge.note}`;
  if (questions > 0 && turn === 'danyel') return `${questions} decisions + your look`;
  if (look.state === 'now') return 'Only your look is left';
  if (turn === 'nobody') return 'Parked';
  return '';
}
