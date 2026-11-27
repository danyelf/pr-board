// What the Mac service tells the sessions it starts for the backlog: one that reads a repo's backlog and proposes
// what to do next, one that acts on the owner's note to a proposal, and one that starts on a picked-up issue.
import { fileURLToPath } from 'node:url';
import { MAX_PICKS, PICK_UP, WAITING, isAsked, type Proposal, type ProposalItem, type Skip } from '../src/shared/backlog.ts';
import { OWNER_NAME } from '../src/shared/config.ts';
import { LABEL_IN_PROGRESS } from '../src/shared/names.ts';
import { itemKey } from '../src/shared/work.ts';
import { closeComment } from './pickup.ts';

/** The status command, beside this file, named the way the sessions run it. */
const PR_STATUS = `node ${fileURLToPath(new URL('./pr-status.ts', import.meta.url))}`;

// The comment goes in plain double quotes holding real line breaks, since a shell keeps "\n" as two characters.
const closeCommand = (repo: string) => `gh issue close <N> -R ${repo} --comment "${closeComment('<the reason>')}"`;

export function proposalPrompt(repo: string, cwd: string, skip: Skip[]): string {
  return [
    `${OWNER_NAME} pressed "Find some more" for ${repo} on PR Board. The PR Board service on the Mac started this fresh session in ${cwd}, a checkout of the default branch, to propose what to pick up next from the backlog.`,
    '',
    'This session only reads. Make no commits, open no PRs, and change nothing on GitHub: no labels, comments or closes.',
    '',
    `1) Read the open issues: gh issue list -R ${repo} --state open --limit 200 --json number,title,labels,createdAt,updatedAt,body,comments`,
    `   Leave out any with the ${LABEL_IN_PROGRESS} label${skip.length > 0 ? ', and these:' : '.'}`,
    ...skip.map((s) => `   #${s.issue}: ${s.why}`),
    `2) Read what has been done lately: gh pr list -R ${repo} --state merged --limit 30 --json number,title,mergedAt,body`,
    '3) Look at the code where it helps you judge an issue.',
    `4) Choose up to ${MAX_PICKS} issues to pick up next, each with a one-line reason: why this one, why now, what it is close to. Choose any number to close, each with a one-line reason: done by an earlier PR (name it), a duplicate of #N, or no longer wanted. Leave every other issue out of the list. An issue you would do soon but not first can be in the list as "later". An issue that can't start until another open issue or PR lands (check that it is still open) goes in the list as "${WAITING}", never as a pick, and its reason names that item: "waiting on #12, which moves the parser". Waiting issues don't count toward the ${MAX_PICKS}.`,
    '5) Write the list to the board in one command, and then stop:',
    `   ${PR_STATUS} propose ${repo} --item "#25 | ${PICK_UP} | why this one" --item "#11 | close | done by #20"`,
    `   If nothing is worth picking up or closing, run it with no --item, so ${OWNER_NAME} hears that.`,
    '',
    `Write the reasons for ${OWNER_NAME}: plain words, one line each, no made-up terms. If the command refuses the list, read why, fix it and run it again. If you can't write a list at all, say why in your last message and end; the board will show ${OWNER_NAME} that the session ended without one.`,
  ].join('\n');
}

const choiceLines = (p: Proposal) =>
  (p.items ?? []).filter(isAsked).map((i: ProposalItem) => `  #${i.issue} ${i.title} → ${p.answers?.[String(i.issue)] ?? '?'} (Claude's reason: ${i.reason})`);

export function notePrompt(p: Proposal, cwd: string): string {
  return [
    `${OWNER_NAME} answered the backlog proposal for ${p.repo} on PR Board, with a note. The PR Board service on the Mac has already carried out the choices, and started this fresh session in ${cwd}, a checkout of the default branch, to act on the note.`,
    '',
    'The choices, now done ("pick up" means the issue has the in-progress label and waits for a session of its own; "close" means it is closed):',
    ...choiceLines(p),
    '',
    `The note: ${(p.note ?? '').split('\n').join('\n  ')}`,
    '',
    'Act on the note, and only on the note:',
    `- To pick up another issue: ${PR_STATUS} pick-up ${p.repo}#<N>`,
    `- To close an issue: ${closeCommand(p.repo)}`,
    `- Start no work on any issue yourself; each picked-up issue gets a session of its own. Make no commits.`,
    '',
    `When you have done what the note asks, end with: ${PR_STATUS} proposal-done ${p.repo}`,
    `If the note asks for something you can't do here, end with: ${PR_STATUS} proposal-done ${p.repo} --problem "what you couldn't do, and why"`,
    `${OWNER_NAME} then sees that line on the board. If the session ends without either, the board tells ${OWNER_NAME} it gave up.`,
  ].join('\n');
}

export function pickupPrompt(repo: string, n: number, cwd: string, reason: string | null): string {
  const ref = itemKey(repo, n);
  return [
    `${OWNER_NAME} picked up ${ref} from the backlog on PR Board${reason ? `, from a proposal that said: ${reason}` : ''}. The PR Board service on the Mac started this fresh session for it in ${cwd}, on the branch issue-${n}.`,
    '',
    `Start with design. Read the issue (gh issue view ${n} -R ${repo} --comments), and before anything else write: ${PR_STATUS} set ${ref} --gate design --state working --ask "Designing"`,
    `Then follow the pr-status skill and the brainstorming skill to work out the design. ${OWNER_NAME} can't answer in this session, so wherever you would ask, choose what you would recommend and put the choice as a question on the board.`,
    `End with ${PR_STATUS} set ${ref} --gate design --state complete --ask "what to look at", or --state paused with your questions. Never end on working: once this session ends, nobody is left to carry on.`,
  ].join('\n');
}
