// The page's pure parts: the element builder, the answer form, and what a refresh replaces.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { drawCard } from '../src/page/draw.ts';
import { el } from '../src/page/el.ts';
import { afterRefusal, formProblem, initialForm, offersQuestions, toAnswer } from '../src/page/form.ts';
import { plan } from '../src/page/merge.ts';
import type { BoardView, CardView } from '../src/shared/view.ts';

/** A stand-in for the browser's Document that records what was made. */
class FakeText {
  readonly data: string;
  constructor(data: string) {
    this.data = data;
  }
}
class FakeElement {
  readonly attrs: Record<string, string> = {};
  readonly children: (FakeElement | FakeText)[] = [];
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  appendChild<T extends FakeElement | FakeText>(n: T): T {
    this.children.push(n);
    return n;
  }
  addEventListener(): void {}
}

/** Every element under `e`, itself included. */
function walk(e: FakeElement): FakeElement[] {
  return [e, ...e.children.flatMap((c) => (c instanceof FakeElement ? walk(c) : []))];
}

/** The text directly and indirectly inside `e`. */
function textOf(e: FakeElement): string {
  return e.children.map((c) => (c instanceof FakeElement ? textOf(c) : c.data)).join('');
}
class FakeDocument {
  readonly made: (FakeElement | FakeText)[] = [];
  createElement(tag: string): FakeElement {
    const e = new FakeElement(tag);
    this.made.push(e);
    return e;
  }
  createTextNode(data: string): FakeText {
    const t = new FakeText(data);
    this.made.push(t);
    return t;
  }
}

function fakeDoc(): { fake: FakeDocument; doc: Document } {
  const fake = new FakeDocument();
  return { fake, doc: fake as unknown as Document };
}

function card(over: Partial<CardView> = {}): CardView {
  return {
    key: 'o/r#5', repo: 'o/r', number: 5, title: 'Item 5', url: 'https://github.com/o/r/pull/5', kind: 'pr', version: 3,
    boxes: [], tag: '1 question', tone: 'owner', turn: 'owner', waitingSince: null, startedAt: '2026-11-19T00:00:00.000Z',
    ask: 'One thing', toTest: null, backReason: null,
    questions: [
      { n: 1, text: 'Pin colour?', choices: ['gold', 'grey'], defaultChoice: 'gold' },
      { n: 2, text: 'Where?', choices: ['top', 'bottom', 'file an issue'], defaultChoice: 'bottom' },
    ],
    approval: null, noteLabel: 'Note', answerState: null, lastAnswer: null, gaveUpHint: null,
    links: { pr: 'https://github.com/o/r/pull/5', issue: null, preview: null, merge: null },
    screenshots: [], labels: { add: [], remove: [] },
    ...over,
  };
}

function board(cards: CardView[]): BoardView {
  return { waiting: cards, onClaude: [], quiet: [], everything: cards, errors: [], generatedAt: '2026-11-20T12:00:00.000Z' };
}

describe('el', () => {
  it('puts text in as one text node with exactly those characters', () => {
    const { fake, doc } = fakeDoc();
    const p = el(doc, 'p', {}, '<script>x</script>') as unknown as FakeElement;
    const texts = fake.made.filter((n): n is FakeText => n instanceof FakeText);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.data).toBe('<script>x</script>');
    expect(p.children).toEqual([texts[0]]);
    expect(fake.made.filter((n) => n instanceof FakeElement).map((n) => (n as FakeElement).tag)).toEqual(['p']);
  });

  it('sets attributes with setAttribute and skips null children', () => {
    const { doc } = fakeDoc();
    const a = el(doc, 'a', { href: 'https://github.com/o/r/pull/5', class: 'link' }, null, 'PR') as unknown as FakeElement;
    expect(a.attrs).toEqual({ href: 'https://github.com/o/r/pull/5', class: 'link' });
    expect(a.children).toHaveLength(1);
  });

  it('refuses event-handler attributes', () => {
    const { doc } = fakeDoc();
    expect(() => el(doc, 'button', { onclick: 'alert(1)' })).toThrow();
    expect(() => el(doc, 'img', { ONerror: 'alert(1)' })).toThrow();
  });

  it('refuses links and sources that are not https or the board\'s own paths', () => {
    const { doc } = fakeDoc();
    expect(() => el(doc, 'a', { href: 'javascript:alert(1)' })).toThrow();
    expect(() => el(doc, 'a', { href: ' javascript:alert(1)' })).toThrow();
    expect(() => el(doc, 'img', { src: 'data:image/png;base64,AAAA' })).toThrow();
    expect(() => el(doc, 'img', { src: 'http://example.com/a.png' })).toThrow();
    expect(() => el(doc, 'a', { href: '/api/board' })).not.toThrow();
    expect(() => el(doc, 'img', { src: 'https://example.com/a.png' })).not.toThrow();
  });
});

describe('page code never writes HTML', () => {
  it('has no innerHTML, outerHTML, insertAdjacentHTML or document.write anywhere under src/page', () => {
    const dir = fileURLToPath(new URL('../src/page/', import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
        expect(text.includes(banned), `${f} contains ${banned}`).toBe(false);
      }
    }
  });
});

describe('the answer form', () => {
  it('starts with each question\'s default and the approval\'s default chosen, untouched', () => {
    const c = card({ approval: { choices: ['approve, build it', 'needs changes'], defaultChoice: 'approve, build it' } });
    expect(initialForm(c)).toEqual({ choices: { '1': 'gold', '2': 'bottom' }, approval: 'approve, build it', note: '', touched: false });
  });

  it('has no approval when the card asks for none', () => {
    expect(initialForm(card()).approval).toBeNull();
  });

  it('turns the form into the answer the board takes', () => {
    const c = card({ approval: { choices: ['looks good, prep for merge', 'needs changes'], defaultChoice: 'looks good, prep for merge' } });
    const s = { choices: { '1': 'grey', '2': 'file an issue' }, approval: 'needs changes', note: 'fix the check', touched: true };
    expect(toAnswer(c, s)).toEqual({ version: 3, choices: { '1': 'grey', '2': 'file an issue' }, approval: 'needs changes', note: 'fix the check' });
  });

  it('sends only the note once the questions have been answered', () => {
    const c = card({ answerState: 'awaiting-pickup', lastAnswer: { at: '2026-11-20T11:59:00.000Z', note: '', choices: { '1': 'gold' } } });
    expect(offersQuestions(c)).toBe(false);
    const s = { choices: { '1': 'grey' }, approval: null, note: 'and also this', touched: true };
    expect(toAnswer(c, s)).toEqual({ version: 3, choices: {}, approval: null, note: 'and also this' });
  });

  it('offers the whole form again, with defaults, after a session gave up, and shows where its output is', () => {
    const c = card({
      answerState: 'gave-up', tag: 'Claude gave up', gaveUpHint: 'Its output is the newest o-r-5-*.log',
      approval: { choices: ['approve, build it', 'needs changes'], defaultChoice: 'approve, build it' },
      lastAnswer: { at: '2026-11-20T11:00:00.000Z', note: '', choices: { '1': 'grey' } },
    });
    expect(offersQuestions(c)).toBe(true);
    const s = initialForm(c);
    expect(s).toEqual({ choices: { '1': 'gold', '2': 'bottom' }, approval: 'approve, build it', note: '', touched: false });
    expect(toAnswer(c, s)).toEqual({ version: 3, choices: { '1': 'gold', '2': 'bottom' }, approval: 'approve, build it', note: '' });

    const { doc } = fakeDoc();
    const node = drawCard(doc, c, s, { send: () => {}, changed: () => {}, reload: () => {} }, new Date('2026-11-20T12:00:00.000Z')) as unknown as FakeElement;
    const radios = walk(node).filter((e) => e.tag === 'input' && e.attrs.type === 'radio');
    expect(radios.map((r) => r.attrs.value)).toEqual(['gold', 'grey', 'top', 'bottom', 'file an issue', 'approve, build it', 'needs changes']);
    expect(walk(node).filter((e) => e.attrs['data-role'] === 'gave-up-hint').map(textOf)).toEqual(['Its output is the newest o-r-5-*.log']);
  });

  it('draws the gate line as the card says, with the round and the reason for the move back after the gate the work is at, and the tag in the card\'s tone', () => {
    const c = card({
      tone: 'claude', backReason: 'too slow',
      boxes: [{ gate: 'design', look: 'approved', round: null }, { gate: 'implementation', look: 'now', round: 2 }, { gate: 'prep', look: 'on-hold', round: null }],
    });
    const { doc } = fakeDoc();
    const node = drawCard(doc, c, initialForm(c), { send: () => {}, changed: () => {}, reload: () => {} }, new Date('2026-11-20T12:00:00.000Z')) as unknown as FakeElement;
    const line = walk(node).find((e) => e.attrs.class === 'gates')!;
    expect(textOf(line)).toBe('Design ✓ › Build (round 2, reopened: too slow) › Prep');
    expect(walk(line).filter((e) => (e.attrs.class ?? '').startsWith('gate ')).map((e) => e.attrs.class)).toEqual(['gate look-approved', 'gate look-now', 'gate look-on-hold']);
    expect(walk(node).find((e) => (e.attrs.class ?? '').startsWith('tag '))?.attrs.class).toBe('tag tone-claude');
    expect(node.attrs.class).toBe('card');
  });

  it('asks for a note with "needs changes"', () => {
    const c = card({ approval: { choices: ['approve, build it', 'needs changes'], defaultChoice: 'approve, build it' } });
    expect(formProblem(c, { ...initialForm(c), approval: 'needs changes' })).toMatch(/note/);
    expect(formProblem(c, { ...initialForm(c), approval: 'needs changes', note: 'redo it' })).toBeNull();
    expect(formProblem(c, initialForm(c))).toBeNull();
  });

  it('keeps the typed note after a refusal, but starts the choices afresh', () => {
    const fresh = card({ version: 4, questions: [{ n: 1, text: 'New question?', choices: ['yes', 'no'], defaultChoice: 'no' }] });
    expect(afterRefusal(fresh, 'please also fix the check')).toEqual({ choices: { '1': 'no' }, approval: null, note: 'please also fix the check', touched: true });
  });

  it('leaves the form untouched after a refusal when no note was typed', () => {
    expect(afterRefusal(card(), '').touched).toBe(false);
  });

  it('asks for a note when there is nothing else to send', () => {
    const c = card({ questions: [] });
    expect(formProblem(c, initialForm(c))).toMatch(/note/);
  });
});

describe('what a refresh replaces', () => {
  it('leaves a card being answered alone', () => {
    const old = card();
    const changed = card({ tag: 'approve build?', version: 4 });
    const p = plan(new Map([[old.key, old]]), board([changed]), new Set([old.key]));
    expect(p.flagChanged).toEqual([old.key]);
    expect(p.redraw).toEqual([]);
  });

  it('redraws a changed card nobody is answering', () => {
    const old = card();
    const p = plan(new Map([[old.key, old]]), board([card({ version: 4 })]), new Set());
    expect(p.redraw).toEqual([old.key]);
    expect(p.flagChanged).toEqual([]);
  });

  it('leaves unchanged cards out of both lists, touched or not', () => {
    const a = card({ key: 'o/r#1', number: 1 });
    const b = card({ key: 'o/r#2', number: 2 });
    const p = plan(new Map([[a.key, a], [b.key, b]]), board([card({ key: 'o/r#1', number: 1 }), card({ key: 'o/r#2', number: 2 })]), new Set([a.key]));
    expect(p).toEqual({ redraw: [], flagChanged: [], add: [], remove: [] });
  });

  it('adds new cards and removes the ones that are gone', () => {
    const a = card({ key: 'o/r#1', number: 1 });
    const b = card({ key: 'o/r#2', number: 2 });
    const p = plan(new Map([[a.key, a]]), board([b]), new Set());
    expect(p.add).toEqual([b.key]);
    expect(p.remove).toEqual([a.key]);
  });
});
