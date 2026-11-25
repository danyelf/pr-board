// The backlog on the page: the line per repo with its "Find some more" button, the proposal card, and the cards of
// picked-up issues. Like the other cards, every element comes from `el`, so text from GitHub or Claude stays text.
import type { BacklogView, PickupCard, ProposalCard } from '../shared/backlog-view.ts';
import { NOTE_MAX } from '../shared/names.ts';
import { age, link, radioGroup } from './draw.ts';
import { el } from './el.ts';

export interface BacklogHandlers {
  findMore(repo: string): void;
  answer(key: string): void;
  /** A one-step action on a card: try again, dismiss or drop. */
  act(key: string, path: string, id: number): void;
}

/** What the owner has chosen on a proposal card so far. */
export interface ProposalForm {
  answers: Record<string, string>;
  note: string;
  touched: boolean;
}

export function initialProposalForm(c: ProposalCard): ProposalForm {
  return { answers: Object.fromEntries(c.questions.map((q) => [String(q.issue), q.defaultChoice])), note: '', touched: false };
}

function button(doc: Document, label: string, onClick: () => void, role?: string): HTMLElement {
  const b = el(doc, 'button', { type: 'button', class: 'small', ...(role ? { 'data-role': role } : {}) }, label);
  b.addEventListener('click', onClick);
  return b;
}

function head(doc: Document, title: HTMLElement | string, repo: string, tag: string, tone: 'owner' | 'claude', since: string, now: Date): HTMLElement {
  return el(doc, 'header', { class: 'card-head' },
    el(doc, 'span', { class: 'title' }, title, ' ', el(doc, 'span', { class: 'repo' }, repo)),
    el(doc, 'span', { class: `tag tone-${tone}` }, tag, ` · ${age(since, now)}`),
  );
}

export function drawProposal(doc: Document, c: ProposalCard, s: ProposalForm, h: BacklogHandlers, now: Date): HTMLElement {
  const parts: (HTMLElement | null)[] = [head(doc, c.title, 'proposal, no issue', c.tag, c.section === 'waiting' ? 'owner' : 'claude', c.since, now)];
  if (c.failure) parts.push(el(doc, 'p', { class: 'gave-up-hint' }, el(doc, 'strong', {}, 'What went wrong: '), c.failure));
  if (c.answerable && c.questions.length === 0) parts.push(el(doc, 'p', { class: 'ask' }, 'Claude found nothing worth picking up or closing. Send to clear the card.'));

  if (c.answerable) {
    const form: HTMLElement[] = c.questions.map((q, i) => {
      const group = radioGroup(doc, `${c.key}-${q.issue}`, null, q.choices, q.defaultChoice, s.answers[String(q.issue)], (choice) => {
        s.answers[String(q.issue)] = choice;
        s.touched = true;
      }, `#${q.issue}`);
      return el(doc, 'div', { class: 'proposal-item' },
        el(doc, 'div', {}, `${i + 1}. `, link(doc, q.url, `#${q.issue} ${q.title}`)),
        el(doc, 'div', { class: 'reason' }, q.reason),
        group,
      );
    });
    const note = el(doc, 'textarea', { rows: '1', maxlength: String(NOTE_MAX), 'aria-label': 'Note', placeholder: 'Note (a note starts a short session that acts on it)', 'data-role': 'note' }) as HTMLTextAreaElement;
    note.value = s.note;
    note.addEventListener('input', () => {
      s.note = note.value;
      s.touched = true;
    });
    const send = el(doc, 'button', { type: 'button', 'data-role': 'send' }, 'Send');
    send.addEventListener('click', () => h.answer(c.key));
    parts.push(el(doc, 'div', { class: 'form' }, ...form, el(doc, 'div', { class: 'note-row' }, note, send)));
  } else if (c.sent) {
    const lines = c.questions.map((q) => el(doc, 'li', {}, `#${q.issue} ${q.title}: ${c.sent!.answers[String(q.issue)] ?? '?'}`));
    if (c.sent.note !== '') lines.push(el(doc, 'li', {}, `Note: ${c.sent.note}`));
    parts.push(el(doc, 'div', { class: 'sent' }, el(doc, 'div', {}, 'You answered'), lines.length > 0 ? el(doc, 'ul', {}, ...lines) : null));
  }
  if (c.canRetry || c.canDismiss) {
    parts.push(el(doc, 'p', { class: 'actions' },
      c.canRetry ? button(doc, 'Try again', () => h.act(c.key, '/api/proposal-retry', c.id)) : null,
      c.canDismiss ? button(doc, 'Dismiss', () => h.act(c.key, '/api/proposal-dismiss', c.id)) : null,
    ));
  }
  parts.push(el(doc, 'p', { class: 'error', 'data-role': 'error', hidden: '' }));
  return el(doc, 'article', { class: 'card', 'data-key': c.key }, ...parts);
}

export function drawPickup(doc: Document, c: PickupCard, h: BacklogHandlers, now: Date): HTMLElement {
  return el(doc, 'article', { class: 'card', 'data-key': c.key },
    head(doc, link(doc, c.url, `#${c.issue} ${c.title}`), c.repo, c.tag, c.section === 'waiting' ? 'owner' : 'claude', c.since, now),
    c.reason ? el(doc, 'p', { class: 'ask' }, `Picked up from a proposal: ${c.reason}`) : null,
    c.failure ? el(doc, 'p', { class: 'gave-up-hint' }, c.failure) : null,
    c.canRetry || c.canDrop
      ? el(doc, 'p', { class: 'actions' },
        c.canRetry ? button(doc, 'Try again', () => h.act(c.key, '/api/pickup-retry', c.id)) : null,
        c.canDrop ? button(doc, 'Drop it', () => h.act(c.key, '/api/pickup-drop', c.id)) : null,
      )
      : null,
    el(doc, 'p', { class: 'error', 'data-role': 'error', hidden: '' }),
  );
}

/** The Backlog section's contents: how many Mac sessions are running, and a line per repo. */
export function drawBacklog(doc: Document, b: BacklogView, h: BacklogHandlers, now: Date): HTMLElement[] {
  const s = b.sessions;
  if (!s) return [el(doc, 'p', { class: 'slots' }, "The Mac service hasn't reported in yet, so nobody would look through a backlog.")];
  const boxes = Array.from({ length: s.max }, (_, i) => el(doc, 'b', { class: i < s.running ? 'f' : '' }));
  const slots = el(doc, 'p', { class: 'slots' }, ...boxes, ` ${s.running} of ${s.max} sessions on the Mac running`,
    s.stale ? el(doc, 'span', { class: 'stale' }, ` · the Mac service last looked ${age(s.at, now)} ago`) : null);
  const lines = b.repos.map((r) => {
    const count = r.open === null ? "couldn't count the open issues" : `${r.atLeast ? 'at least ' : ''}${r.open} open ${r.open === 1 ? 'issue' : 'issues'} nobody has picked up`;
    return el(doc, 'div', { class: 'backlog-line', 'data-repo': r.repo },
      el(doc, 'b', {}, r.name),
      el(doc, 'span', { class: 'n' }, r.busy ?? count),
      r.busy === null ? button(doc, 'Find some more', () => h.findMore(r.repo), 'find-more') : null,
      el(doc, 'span', { class: 'error', 'data-role': 'error', hidden: '' }),
    );
  });
  return [slots, ...lines];
}
