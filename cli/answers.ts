// The owner's answers in words, as the watcher prints them for the session that handed the work over.
import { itemKey, recordNumber, type AnswerRow, type WorkRecord } from '../src/shared/work.ts';

/** The item, each question with the choice made, the approval if any, and the note, indented. */
export function describe(record: WorkRecord, answers: AnswerRow[]): string {
  // The work as the session knows it: the PR when there is one, otherwise the issue.
  const lines = [itemKey(record.repo, recordNumber(record))];
  for (const a of answers) {
    for (const q of record.questions) {
      const choice = a.choices[String(q.n)];
      if (choice !== undefined) lines.push(`  ${q.n}. ${q.text} → ${choice}`);
    }
    if (a.approval) lines.push(`  Approval: ${a.approval}`);
    if (a.note) lines.push(`  Note: ${a.note.split('\n').join('\n    ')}`);
  }
  return lines.join('\n');
}
