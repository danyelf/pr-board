// Cards, gate strips and sections, drawn from the board's JSON. Every element comes from `el`, so text
// from GitHub or from Claude is always shown as text.
import { NOTE_MAX } from '../shared/names.ts';
import { NEEDS_CHANGES_PLACEHOLDER, type CardView } from '../shared/view.ts';
import { GATE_SHORT_NAMES, NEEDS_CHANGES } from '../shared/work.ts';
import { el } from './el.ts';
import { canAnswer, offersQuestions, type FormState } from './form.ts';

export interface CardHandlers {
  /** Called after the owner changes a choice or the note. */
  changed(key: string): void;
  send(key: string): void;
  /** Throws away what the owner had started and draws the card's latest state. */
  reload(key: string): void;
}

/** "HH:MM" in the viewer's own time. */
export function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** How long ago, shortly: "5 min", "3 h", "2 d". */
export function age(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** Makes a link, or plain text when the address isn't one the page may link to. */
function link(doc: Document, href: string, text: string, cls?: string): HTMLElement {
  try {
    return el(doc, 'a', { href, rel: 'noreferrer', target: '_blank', ...(cls ? { class: cls } : {}) }, text);
  } catch {
    return el(doc, 'span', cls ? { class: cls } : {}, text);
  }
}

/** "Design ✓ › Build › Prep", with the gate the work is at in bold, and its round and reopening reason after it. */
function gateLine(doc: Document, c: CardView): HTMLElement {
  const parts: (HTMLElement | string)[] = [];
  c.boxes.forEach((b, i) => {
    if (i > 0) parts.push(' › ');
    parts.push(el(doc, 'span', { class: `gate look-${b.look}` }, GATE_SHORT_NAMES[b.gate], b.look === 'approved' ? ' ✓' : ''));
    if (b.look !== 'now') return;
    const notes = [b.round !== null ? `round ${b.round}` : null, c.backReason ? `reopened: ${c.backReason}` : null].filter((n) => n !== null);
    if (notes.length > 0) parts.push(el(doc, 'span', { class: 'gate-note' }, ` (${notes.join(', ')})`));
  });
  return el(doc, 'div', { class: 'gates' }, ...parts);
}

function header(doc: Document, c: CardView, now: Date): HTMLElement {
  return el(doc, 'header', { class: 'card-head' },
    el(doc, 'span', { class: 'title' }, link(doc, c.url, `#${c.number} ${c.title}`), ' ', el(doc, 'span', { class: 'repo' }, c.repo)),
    el(doc, 'span', { class: `tag tone-${c.tone}` }, c.tag, c.waitingSince ? ` · ${age(c.waitingSince, now)}` : ''),
  );
}

function links(doc: Document, c: CardView): HTMLElement | null {
  const items: HTMLElement[] = [];
  if (c.links.merge) items.push(link(doc, c.links.merge, 'Merge on GitHub', 'merge'));
  if (c.links.pr && c.kind !== 'pr') items.push(link(doc, c.links.pr, 'PR'));
  if (c.links.issue) items.push(link(doc, c.links.issue, 'Issue'));
  if (c.links.preview) items.push(link(doc, c.links.preview, 'Preview'));
  return items.length > 0 ? el(doc, 'span', { class: 'links' }, ...items) : null;
}

function screenshots(doc: Document, c: CardView): HTMLElement | null {
  const shots: HTMLElement[] = [];
  for (const src of c.screenshots) {
    try {
      shots.push(el(doc, 'a', { href: src, target: '_blank', rel: 'noreferrer' }, el(doc, 'img', { src, alt: 'Screenshot', loading: 'lazy' })));
    } catch {
      // An address the page may not load is left out.
    }
  }
  return shots.length > 0 ? el(doc, 'div', { class: 'shots' }, ...shots) : null;
}

/** What the owner sent for this version. */
function sent(doc: Document, c: CardView): HTMLElement | null {
  const a = c.lastAnswer;
  if (!a) return null;
  const lines: HTMLElement[] = [];
  if (a.approval !== null) lines.push(el(doc, 'li', {}, a.approval));
  for (const [n, choice] of Object.entries(a.choices)) {
    const q = c.questions.find((x) => String(x.n) === n);
    lines.push(el(doc, 'li', {}, q ? `${n}. ${q.text}: ${choice}` : `${n}. ${choice}`));
  }
  if (a.note !== '') lines.push(el(doc, 'li', {}, `Note: ${a.note}`));
  return el(doc, 'div', { class: 'sent' },
    el(doc, 'div', {}, `You answered at ${clock(new Date(a.at))}`),
    lines.length > 0 ? el(doc, 'ul', {}, ...lines) : null,
  );
}

/** A choice for each option, the default in bold. A group with no legend is the approval, named for screen readers only. */
function radioGroup(
  doc: Document,
  name: string,
  legend: string | null,
  choices: string[],
  defaultChoice: string,
  chosen: string | undefined,
  onPick: (choice: string) => void,
): HTMLElement {
  return el(doc, 'fieldset', { class: 'question', ...(legend === null ? { 'aria-label': 'Approval' } : {}) },
    legend !== null ? el(doc, 'legend', {}, legend) : null,
    ...choices.map((choice) => {
      const input = el(doc, 'input', { type: 'radio', name, value: choice, ...(chosen === choice ? { checked: '' } : {}) }) as HTMLInputElement;
      input.addEventListener('change', () => {
        if (input.checked) onPick(choice);
      });
      return el(doc, 'label', { class: choice === defaultChoice ? 'choice default' : 'choice' }, input, ' ', choice);
    }),
  );
}

function form(doc: Document, c: CardView, s: FormState, h: CardHandlers): HTMLElement {
  const parts: HTMLElement[] = [];
  const offered = offersQuestions(c);
  if (offered) {
    for (const q of c.questions) {
      parts.push(radioGroup(doc, `${c.key}-q${q.n}`, `${q.n}. ${q.text}`, q.choices, q.defaultChoice, s.choices[String(q.n)], (choice) => {
        s.choices[String(q.n)] = choice;
        s.touched = true;
        h.changed(c.key);
      }));
    }
  }
  const note = el(doc, 'textarea', { rows: '1', maxlength: String(NOTE_MAX), 'aria-label': 'Note', 'data-role': 'note' }) as HTMLTextAreaElement;
  note.value = s.note;
  const showRequired = () => {
    const needed = offered && c.approval !== null && s.approval === NEEDS_CHANGES;
    note.required = needed;
    note.setAttribute('placeholder', needed ? NEEDS_CHANGES_PLACEHOLDER : c.noteLabel);
  };
  if (offered && c.approval) {
    parts.push(radioGroup(doc, `${c.key}-approval`, null, c.approval.choices, c.approval.defaultChoice, s.approval ?? undefined, (choice) => {
      s.approval = choice;
      s.touched = true;
      showRequired();
      h.changed(c.key);
    }));
  }
  showRequired();
  note.addEventListener('input', () => {
    s.note = note.value;
    if (s.note !== '') s.touched = true;
    h.changed(c.key);
  });
  const button = el(doc, 'button', { type: 'button', title: 'Ctrl+Enter', 'data-role': 'send' }, 'Send');
  button.addEventListener('click', () => h.send(c.key));
  parts.push(el(doc, 'div', { class: 'note-row' }, note, button));
  return el(doc, 'div', { class: 'form' }, ...parts);
}

export function drawCard(doc: Document, c: CardView, s: FormState, h: CardHandlers, now: Date): HTMLElement {
  const changed = el(doc, 'div', { class: 'changed', 'data-role': 'changed', hidden: '' }, 'Changed since you started. ');
  const reload = el(doc, 'button', { type: 'button', class: 'linkish' }, 'Reload');
  reload.addEventListener('click', () => h.reload(c.key));
  changed.appendChild(reload);
  changed.appendChild(doc.createTextNode(' (loses what you typed)'));

  const linkLine = links(doc, c);
  const node = el(doc, 'article', { class: 'card', 'data-key': c.key },
    header(doc, c, now),
    changed,
    c.boxes.length > 0 ? gateLine(doc, c) : null,
    c.ask !== '' || linkLine ? el(doc, 'p', { class: 'ask' }, c.ask, linkLine) : null,
    c.toTest ? el(doc, 'p', { class: 'to-test' }, el(doc, 'strong', {}, 'To test: '), c.toTest) : null,
    screenshots(doc, c),
    offersQuestions(c) && c.answerState !== 'gave-up' ? null : sent(doc, c),
    c.gaveUpHint ? el(doc, 'p', { class: 'gave-up-hint', 'data-role': 'gave-up-hint' }, c.gaveUpHint) : null,
    el(doc, 'p', { class: 'error', 'data-role': 'error', hidden: '' }),
    canAnswer(c) ? form(doc, c, s, h) : null,
  );
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canAnswer(c)) {
      e.preventDefault();
      h.send(c.key);
    }
  });
  return node;
}

function part(node: HTMLElement, role: string): HTMLElement | null {
  return node.querySelector(`[data-role="${role}"]`);
}

export function showError(node: HTMLElement, message: string | null): void {
  const p = part(node, 'error');
  if (!p) return;
  p.textContent = message ?? '';
  p.hidden = message === null;
}

export function showSending(node: HTMLElement, sending: boolean): void {
  const b = part(node, 'send') as HTMLButtonElement | null;
  if (!b) return;
  b.disabled = sending;
  b.textContent = sending ? 'Sending…' : 'Send';
}

export function showChanged(node: HTMLElement, changed: boolean): void {
  const p = part(node, 'changed');
  if (p) p.hidden = !changed;
}

/** Puts exactly these nodes in the container, in this order, moving only the ones out of place, so a card being typed in keeps its focus. */
export function arrange(container: HTMLElement, nodes: HTMLElement[]): void {
  const wanted = new Set<Node>(nodes);
  for (const child of [...container.children]) if (!wanted.has(child)) child.remove();
  nodes.forEach((n, i) => {
    const at = container.children[i];
    if (at !== n) container.insertBefore(n, at ?? null);
  });
}
