// The page: reads the board, draws it, keeps it current, and sends the owner's answers.
import type { BoardView, CardView } from '../shared/view.ts';
import { arrange, clock, drawCard, showChanged, showError, showSending, type CardHandlers } from './draw.ts';
import { el } from './el.ts';
import { afterRefusal, formProblem, initialForm, toAnswer, type FormState } from './form.ts';
import { plan } from './merge.ts';

const REFRESH_MS = 30_000;

type View = 'turn' | 'everything';

const doc = document;

/** The card each node was drawn from. */
const drawn = new Map<string, CardView>();
/** The newer state of a card the owner is answering, kept until they reload it. */
const newer = new Map<string, CardView>();
const nodes = new Map<string, HTMLElement>();
const forms = new Map<string, FormState>();
const sending = new Set<string>();

let board: BoardView | null = null;
let lastGood: Date | null = null;
let refreshing = false;
let view: View = readView();

function readView(): View {
  return new URLSearchParams(location.search).get('view') === 'everything' ? 'everything' : 'turn';
}

function writeView(v: View): void {
  const url = new URL(location.href);
  url.searchParams.set('view', v);
  history.replaceState(null, '', url);
}

const handlers: CardHandlers = {
  changed: () => undefined,
  send: (key) => void send(key),
  reload: (key) => {
    const c = newer.get(key) ?? drawn.get(key);
    newer.delete(key);
    if (c) replaceCard(c);
  },
};

function touched(): Set<string> {
  const keys = new Set(sending);
  for (const [k, s] of forms) if (s.touched) keys.add(k);
  return keys;
}

/** Draws the card afresh in place of whatever node it had, with the given form or an untouched one. */
function replaceCard(c: CardView, s: FormState = initialForm(c)): HTMLElement {
  const node = drawCard(doc, c, s, handlers, new Date());
  nodes.get(c.key)?.replaceWith(node);
  nodes.set(c.key, node);
  forms.set(c.key, s);
  drawn.set(c.key, c);
  newer.delete(c.key);
  return node;
}

/** Puts a card the server sent into the board kept in memory, so a later layout uses it. */
function remember(c: CardView): void {
  if (!board) return;
  const swap = (list: CardView[]) => list.map((x) => (x.key === c.key ? c : x));
  board = { ...board, waiting: swap(board.waiting), onClaude: swap(board.onClaude), quiet: swap(board.quiet), everything: swap(board.everything) };
}

async function send(key: string): Promise<void> {
  const c = drawn.get(key);
  const s = forms.get(key);
  const node = nodes.get(key);
  if (!c || !s || !node || sending.has(key)) return;
  const problem = formProblem(c, s);
  if (problem) {
    showError(node, problem);
    return;
  }
  showError(node, null);
  sending.add(key);
  showSending(node, true);
  let res: Response;
  try {
    res = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: c.repo, number: c.number, ...toAnswer(c, s) }),
    });
  } catch {
    sending.delete(key);
    showSending(node, false);
    showError(node, "Couldn't reach the board. Your answer was not sent; try again.");
    return;
  }
  sending.delete(key);
  const body = (await res.json().catch(() => null)) as { card?: CardView | null; error?: string } | null;
  if (res.status === 200 && body?.card) {
    remember(body.card);
    replaceCard(body.card);
    layout();
    // The reply says what the card looks like, not which section it now belongs in; the board does.
    void refresh();
    return;
  }
  if (res.status === 409 && body?.card) {
    remember(body.card);
    const fresh = replaceCard(body.card, afterRefusal(body.card, s.note));
    showError(fresh, body.error ?? 'The board refused this answer.');
    layout();
    return;
  }
  showSending(node, false);
  if (res.status === 200 || res.status === 409) {
    // The record has ended since the page drew it.
    showError(node, body?.error ?? 'This item is no longer open on the board.');
    void refresh();
    return;
  }
  showError(node, `The board didn't take the answer (${res.status}${body?.error ? `: ${body.error}` : ''}). What you wrote is still here; try again.`);
}

// The page's fixed parts.
const root = doc.getElementById('board')!;
const statusLine = el(doc, 'p', { class: 'status', role: 'status' });
const errors = el(doc, 'div', { class: 'errors', hidden: '' });
const turnButton = el(doc, 'button', { type: 'button' }, 'By turn');
const everythingButton = el(doc, 'button', { type: 'button' }, 'All');
const sections: Record<'waiting' | 'onClaude' | 'quiet' | 'everything', { wrap: HTMLElement; list: HTMLElement; count: HTMLElement | null }> = {
  waiting: section('Your turn'),
  onClaude: section("Claude's turn"),
  quiet: section('Quiet'),
  // The switch already says this is everything, newest first.
  everything: section(null),
};

function section(title: string | null): { wrap: HTMLElement; list: HTMLElement; count: HTMLElement | null } {
  const count = title !== null ? el(doc, 'span', { class: 'count' }) : null;
  const list = el(doc, 'div', { class: 'cards' });
  const wrap = el(doc, 'section', {}, title !== null && count ? el(doc, 'h2', {}, title, count) : null, list);
  return { wrap, list, count };
}

function setViewButtons(): void {
  turnButton.setAttribute('aria-pressed', String(view === 'turn'));
  everythingButton.setAttribute('aria-pressed', String(view === 'everything'));
}

for (const [button, v] of [[turnButton, 'turn'], [everythingButton, 'everything']] as const) {
  button.addEventListener('click', () => {
    view = v;
    writeView(v);
    setViewButtons();
    layout();
  });
}

root.replaceChildren(
  el(doc, 'header', { class: 'top' },
    el(doc, 'h1', {}, 'PR Board'),
    el(doc, 'div', { class: 'switch', role: 'group', 'aria-label': 'View' }, turnButton, everythingButton),
    statusLine,
  ),
  errors,
  sections.waiting.wrap,
  sections.onClaude.wrap,
  sections.quiet.wrap,
  sections.everything.wrap,
);
setViewButtons();

/** Places the card nodes in the sections of the current view. */
function layout(): void {
  if (!board) return;
  const shown: (keyof typeof sections)[] = view === 'turn' ? ['waiting', 'onClaude', 'quiet'] : ['everything'];
  for (const [name, s] of Object.entries(sections) as [keyof typeof sections, (typeof sections)[keyof typeof sections]][]) {
    if (!shown.includes(name)) {
      s.wrap.hidden = true;
      continue;
    }
    const cards = board[name];
    // An empty section is left out.
    s.wrap.hidden = cards.length === 0;
    arrange(s.list, cards.map((c) => nodes.get(c.key)).filter((n): n is HTMLElement => n !== undefined));
    if (s.count) s.count.textContent = ` · ${cards.length}`;
  }
  // Nodes of cards that are in no shown section are dropped from the page but kept, so a view switch brings them back as they were.
  for (const name of Object.keys(sections) as (keyof typeof sections)[]) {
    if (!shown.includes(name)) sections[name].list.replaceChildren();
  }
}

function showStatus(failed: boolean): void {
  const when = lastGood ? clock(lastGood) : 'never';
  statusLine.textContent = failed ? `Couldn't refresh; last updated ${when}` : `Updated ${when}`;
  statusLine.classList.toggle('failed', failed);
}

function showErrors(list: string[]): void {
  errors.hidden = list.length === 0;
  errors.replaceChildren(...(list.length > 0 ? [el(doc, 'p', {}, 'Some of GitHub could not be read:'), el(doc, 'ul', {}, ...list.map((e) => el(doc, 'li', {}, e)))] : []));
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const res = await fetch('/api/board', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    const next = (await res.json()) as BoardView;
    const p = plan(drawn, next, touched());
    const byKey = new Map(next.everything.map((c) => [c.key, c]));
    for (const key of [...p.add, ...p.redraw]) replaceCard(byKey.get(key)!);
    for (const key of p.flagChanged) {
      newer.set(key, byKey.get(key)!);
      showChanged(nodes.get(key)!, true);
    }
    for (const key of p.remove) {
      nodes.get(key)?.remove();
      for (const m of [nodes, drawn, newer, forms]) m.delete(key);
    }
    board = next;
    lastGood = new Date();
    showErrors(next.errors);
    layout();
    showStatus(false);
  } catch {
    showStatus(true);
  } finally {
    refreshing = false;
  }
}

setInterval(() => {
  if (doc.visibilityState === 'visible') void refresh();
}, REFRESH_MS);
doc.addEventListener('visibilitychange', () => {
  if (doc.visibilityState === 'visible') void refresh();
});
void refresh();
