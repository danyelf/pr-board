import type { BoxState, ItemFacts, StageBox, Status, Turn } from './types.ts';
import { effectiveTurn, formatWait, mergeBlockers, waitingSince } from './turn.ts';

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function box(name: StageBox['name'], state: BoxState, note = ''): StageBox {
  return { name, state, note };
}

/** The box with this name. Every strip has all six, so a missing one is a bug. */
export function boxNamed(strip: StageBox[], name: StageBox['name']): StageBox {
  const found = strip.find((b) => b.name === name);
  if (!found) throw new Error(`The stage strip has no "${name}" box`);
  return found;
}

function mergeBox(f: ItemFacts, s: Status | null, turn: Turn, now: Date): StageBox {
  if (f.merged) return box('Ready for merge', 'done');
  const blockers = mergeBlockers(f, s, turn);
  if (blockers.length === 0) {
    const since = waitingSince(f, s);
    return box('Ready for merge', 'ready', since ? formatWait(since, now) : '');
  }
  // Before the merge step, only the blockers already known to be coming are worth a note, and the box stays plain.
  const atMergeStep = !blockers.some((b) => b.notYetAtMerge);
  const note = blockers.find((b) => (atMergeStep || b.showEarly) && b.note(f) !== null)?.note(f) ?? null;
  return box('Ready for merge', atMergeStep && note ? 'blocked' : 'todo', note ?? '');
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
    : !isPr && turn === 'owner' ? box('Design', 'now')
    : box('Design', 'todo');

  // A code review Claude posted before prep is a note on Build, not a stage of its own.
  // When the reviewed commit isn't among the PR's commits any more, the PR was rebased or force-pushed
  // after the review, so we can't say how much has changed since.
  const sinceReview = f.commitsSinceReview ?? 0;
  const build = !isPr ? box('Build', 'todo')
    : f.reviewSha === null ? box('Build', 'done', '✓')
    : f.commitsSinceReview === null ? box('Build', 'done', '✓ reviewed before a rebase')
    : sinceReview > 0 ? box('Build', 'done', `✓ reviewed, ${count(sinceReview, 'commit')} since`)
    : box('Build', 'done', '✓ reviewed');

  // Prep for merge runs after the owner's look, once they say the PR looks good.
  const sincePrep = f.commitsSincePrep ?? 0;
  const prep = !f.prepDone ? box('Prep', 'todo')
    : sincePrep > 0 ? box('Prep', 'done', `✓ ${count(sincePrep, 'commit')} since`)
    : box('Prep', 'done', '✓');

  let look: StageBox;
  if (f.merged || f.prepDone) {
    look = box('Your look', 'done');
  } else if (turn === 'owner') {
    // How long it has waited is already in the card's header, so the box only counts questions.
    look = box('Your look', 'now', questions > 0 ? count(questions, 'question') : '');
  } else {
    look = box('Your look', 'todo');
  }

  return [issue, design, build, look, prep, mergeBox(f, s, turn, now)];
}

/** The short reason a card is where it is. `strip` and `turn` are the ones already worked out for the item. */
export function whyTag(s: Status | null, strip: StageBox[], turn: Turn): string {
  const merge = boxNamed(strip, 'Ready for merge');
  const look = boxNamed(strip, 'Your look');
  const questions = s?.questions.length ?? 0;
  if (merge.state === 'ready') return 'Ready to merge';
  if (merge.state === 'blocked') return `Can't merge yet: ${merge.note}`;
  if (questions > 0 && turn === 'owner') return `${count(questions, 'decision')} + your look`;
  if (look.state === 'now') return 'Needs your look';
  if (turn === 'nobody') return 'Parked';
  return '';
}
