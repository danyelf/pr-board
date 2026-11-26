// The page: reads the board, draws it, keeps it current, and sends the owner's answers.
import type { BoardPage, PickupCard, ProposalCard } from '../shared/backlog-view.ts';
import type { CardView } from '../shared/view.ts';
import { drawBacklog, drawPickup, drawProposal, drawWaiting, initialProposalForm, type BacklogHandlers, type ProposalForm } from './backlog.ts';
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

let board: BoardPage | null = null;

/** The backlog's cards as drawn: the JSON each was drawn from, its node, and a proposal's form. */
const backlogCards = new Map<string, { json: string; node: HTMLElement; form: ProposalForm | null }>();
const backlogBusy = new Set<string>();
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

/** Posts one backlog action; on success the board is read again, on failure the error is shown on `node`. */
async function backlogPost(key: string, node: HTMLElement | undefined, path: string, body: unknown): Promise<void> {
  if (backlogBusy.has(key)) return;
  backlogBusy.add(key);
  const showProblem = (text: string) => {
    if (node) showError(node, text);
  };
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reply = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      showProblem(reply?.error ?? `The board didn't take it (${res.status}).`);
      return;
    }
    // The answer is sent, so the form no longer needs keeping.
    const kept = backlogCards.get(key);
    if (kept?.form) kept.form.touched = false;
  } catch {
    showProblem("Couldn't reach the board; try again.");
    return;
  } finally {
    backlogBusy.delete(key);
  }
  await refresh();
}

const backlogHandlers: BacklogHandlers = {
  findMore: (repo) => void backlogPost(`find-more ${repo}`, backlogBody.querySelector<HTMLElement>(`[data-repo="${CSS.escape(repo)}"]`) ?? undefined, '/api/find-more', { repo }),
  answer: (key) => {
    const kept = backlogCards.get(key);
    const c = board?.backlog.proposals.find((p) => p.key === key);
    if (!kept?.form || !c) return;
    void backlogPost(key, kept.node, '/api/proposal-answer', { id: c.id, answers: kept.form.answers, note: kept.form.note });
  },
  act: (key, path, id) => void backlogPost(key, backlogCards.get(key)?.node, path, { id }),
};

/** Draws the backlog's cards afresh where they changed, keeping a proposal the owner has started answering. */
function drawBacklogCards(next: BoardPage): void {
  const now = new Date();
  const seen = new Set<string>();
  const place = (c: ProposalCard | PickupCard, draw: (form: ProposalForm | null) => HTMLElement, form: (old: ProposalForm | null) => ProposalForm | null) => {
    seen.add(c.key);
    const json = JSON.stringify(c);
    const kept = backlogCards.get(c.key);
    if (kept && (kept.json === json || kept.form?.touched)) return;
    const f = form(kept?.form ?? null);
    const node = draw(f);
    kept?.node.replaceWith(node);
    backlogCards.set(c.key, { json, node, form: f });
  };
  for (const p of next.backlog.proposals) {
    place(p, (f) => drawProposal(doc, p, f ?? initialProposalForm(p), backlogHandlers, now), () => (p.answerable ? initialProposalForm(p) : null));
  }
  for (const u of next.backlog.pickups) place(u, () => drawPickup(doc, u, backlogHandlers, now), () => null);
  for (const [key, kept] of [...backlogCards]) {
    if (!seen.has(key)) {
      kept.node.remove();
      backlogCards.delete(key);
    }
  }
  backlogBody.replaceChildren(...drawBacklog(doc, next.backlog, backlogHandlers, now));
  waitingList.replaceChildren(...drawWaiting(doc, next.backlog.waiting));
  waitingCount.textContent = ` · ${next.backlog.waiting.length}`;
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
  quiet: section('Parked'),
  // The switch's "All" already names this list, so it has no heading.
  everything: section(null),
};

// Issues a proposal said can't start until other work lands; they sit after Parked, the other work on hold.
const waitingCount = el(doc, 'span', { class: 'count' });
const waitingList = el(doc, 'div', { class: 'waiting-list' });
const waitingWrap = el(doc, 'section', { hidden: '' }, el(doc, 'h2', {}, 'Waiting on other work', waitingCount), waitingList);

const backlogBody = el(doc, 'div', { class: 'backlog' });
const backlogWrap = el(doc, 'section', { hidden: '' }, el(doc, 'h2', {}, 'Backlog'), backlogBody);

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
  waitingWrap,
  sections.everything.wrap,
  backlogWrap,
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
    const cardNodes = board[name].map((c) => nodes.get(c.key)).filter((n): n is HTMLElement => n !== undefined);
    // The backlog's cards follow the work's in the two turn sections.
    const extra = name === 'waiting' || name === 'onClaude'
      ? [...board.backlog.proposals, ...board.backlog.pickups].filter((c) => c.section === name).map((c) => backlogCards.get(c.key)?.node).filter((n): n is HTMLElement => n !== undefined)
      : [];
    const all = [...cardNodes, ...extra];
    // An empty section is left out.
    s.wrap.hidden = all.length === 0;
    arrange(s.list, all);
    if (s.count) s.count.textContent = ` · ${all.length}`;
  }
  backlogWrap.hidden = view !== 'turn';
  waitingWrap.hidden = view !== 'turn' || board.backlog.waiting.length === 0;
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
    const next = (await res.json()) as BoardPage;
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
    drawBacklogCards(next);
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
