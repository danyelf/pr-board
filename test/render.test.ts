import { describe, expect, it } from 'vitest';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import { renderStatus } from '../src/shared/status.ts';
import { buildBoard } from '../src/worker/board.ts';
import { renderBoard } from '../src/worker/render.ts';
import { facts, status } from './helpers.ts';
import { NOW, boardItems } from './board-items.ts';

async function page(extra = [] as ReturnType<typeof facts>[], errors: string[] = []): Promise<string> {
  const items = [...(await boardItems()), ...extra];
  return renderBoard(buildBoard(items, errors, NOW));
}

describe('renderBoard', () => {
  it('shows each waiting card with its number, why tag, preview and test protocol', async () => {
    const html = await page();
    expect(html).toContain('#573');
    expect(html).toContain('Needs your look');
    expect(html).toContain('panels-unchanged-torahmap.danyel.workers.dev');
    expect(html).toContain('search for a word, open the search panel, pin a verse');
  });

  it("shows the status's Ask as one line under the title", async () => {
    const body = renderStatus(status({ waitingOn: 'owner', ask: 'Pick a <colour> for the button' }));
    const html = await page([facts({ number: 960, labels: ['on sam'], body, lastActivityAt: '2026-11-05T23:00:00Z' })]);
    const card = html.slice(html.indexOf('PR #960'));
    expect(card).toContain('<div class="ask">Pick a &lt;colour&gt; for the button</div>');
    expect(card.indexOf('class="ask"')).toBeLessThan(card.indexOf('class="steps"'));
  });

  it('says so when no status has been written', async () => {
    expect(await page([facts({ number: 900, labels: ['on sam'],lastActivityAt: '2026-11-05T23:00:00Z' })])).toContain('No status written yet');
  });

  it('tags a card whose status text was edited by hand, and shows what the text says', async () => {
    const body = renderStatus(status({ waitingOn: 'owner', ask: 'look at it' })).replace('**Ask:** look at it', '**Ask:** look at it again');
    const html = await page([facts({ number: 961, labels: ['on sam'], body, lastActivityAt: '2026-11-05T23:00:00Z' })]);
    const card = html.slice(html.indexOf('PR #961'));
    expect(card).toContain('status edited by hand; rewrite it with pr-status set');
    expect(card).toContain('<div class="ask">look at it again</div>');
    const clean = await page([facts({ number: 962, labels: ['on sam'], body: renderStatus(status({ waitingOn: 'owner' })), lastActivityAt: '2026-11-05T23:00:00Z' })]);
    expect(clean).not.toContain('edited by hand');
  });

  it('flags a label that disagrees with the status', async () => {
    expect(await page()).toContain('label out of sync');
  });

  it('tags a waiting card, and an On Claude row, whose status is older than the latest change', async () => {
    const body = renderStatus(status({ waitingOn: 'owner' }));
    const claudeBody = renderStatus(status({ waitingOn: 'claude' }));
    const times = { statusWrittenAt: '2026-11-05T10:00:00Z', lastChangeAt: '2026-11-05T12:00:00Z' };
    const html = await page([
      facts({ number: 950, labels: ['on sam'], body, lastActivityAt: '2026-11-05T23:00:00Z', ...times }),
      facts({ number: 951, labels: ['in-progress'], body: claudeBody, lastActivityAt: '2026-11-05T23:00:00Z', ...times }),
    ]);
    const waiting = html.slice(html.indexOf('PR #950'), html.indexOf('On Claude'));
    expect(waiting).toContain('<span class="sync">status older than latest change</span>');
    const claude = html.slice(html.indexOf('On Claude'), html.indexOf('Quiet:'));
    expect(claude).toMatch(/last activity [^<]* ago · status older than latest change</);
    // A status that is up to date says nothing.
    const fresh = renderBoard(buildBoard([
      facts({ number: 952, labels: ['on sam'], body, lastActivityAt: '2026-11-05T23:00:00Z', statusWrittenAt: '2026-11-05T13:00:00Z', lastChangeAt: '2026-11-05T12:00:00Z' }),
    ], [], NOW));
    expect(fresh).not.toContain('status older than latest change');
  });

  it('never calls an unlabelled item Claude working', async () => {
    const html = await page([facts({ number: 901, lastActivityAt: '2026-11-05T23:30:00Z' })]);
    expect(html).toContain('no turn label');
  });

  it('escapes GitHub text', async () => {
    const html = await page([facts({ number: 902, title: '<script>alert(1)</script>', labels: ['in-progress'], lastActivityAt: '2026-11-05T23:30:00Z' })]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('draws each question as choices with the default checked and standing out, and a last file-an-issue choice', async () => {
    const html = await page();
    const card = html.slice(html.indexOf('PR #574'));
    expect(card).toMatch(/<label class="btn default"><input type="radio" name="q1" value="leave" checked><span>leave<\/span><\/label>/);
    expect(card).toMatch(/<label class="btn"><input type="radio" name="q1" value="change"><span>change<\/span><\/label>/);
    expect(card).toMatch(/<label class="btn"><input type="radio" name="q1" value="file an issue"><span>file an issue<\/span><\/label>/);
  });

  it('starts with the update time in Pacific time', async () => {
    expect(await page()).toContain('Updated Nov 5, 4:00 PM PST');
  });

  it('shows error lines at the top', async () => {
    expect(await page([], ["Couldn't read danyelf/broken"])).toContain("Couldn&#39;t read danyelf/broken");
  });

  it('says nothing is waiting only when GitHub was read in full', () => {
    expect(renderBoard(buildBoard([], [], NOW))).toContain('Nothing is waiting on you.');
  });

  it('never says nothing is waiting when GitHub could not be read in full', () => {
    const html = renderBoard(buildBoard([], ['GitHub said 401 Unauthorized'], NOW));
    expect(html).not.toContain('Nothing is waiting on you');
    expect(html).toContain("Couldn&#39;t read everything from GitHub, so this list may be incomplete.");
  });

  it('says when a status section is there but could not be read', async () => {
    const body = '<!-- status -->\n**Waiting on:** Sam, since yesterday afternoon\n<!-- /status -->';
    const html = await page([facts({ number: 907, labels: ['on sam'], body, lastActivityAt: '2026-11-05T23:00:00Z' })]);
    expect(html).toContain("The status section couldn&#39;t be read");
  });

  it('lists quiet items with a reason', async () => {
    const html = await page([
      facts({ number: 903, labels: ['parked'], lastActivityAt: '2026-11-05T23:00:00Z' }),
      facts({ number: 904, labels: ['in-progress'], lastActivityAt: '2026-11-02T00:00:00Z' }),
    ]);
    expect(html).toContain('parked');
    expect(html).toContain('no activity for 4 days');
  });

  it('links Merge on GitHub to the PR when the merge box is ready', async () => {
    const ready = facts({
      number: 905, url: 'https://github.com/danyelf/torahmap/pull/905', labels: ['on sam'],
      prepDone: true, commitsSincePrep: 0, mergeState: 'CLEAN', lastActivityAt: '2026-11-05T23:00:00Z',
    });
    const html = await page([ready]);
    expect(html).toContain('Merge on GitHub');
    expect(html).toContain('href="https://github.com/danyelf/torahmap/pull/905"');
  });

  it('links every number to GitHub and says whether it is a PR or an issue', () => {
    const html = renderBoard(buildBoard([
      facts({ number: 910, labels: ['on sam'], url: 'https://github.com/danyelf/torahmap/pull/910', lastActivityAt: '2026-11-05T23:00:00Z' }),
      facts({ number: 911, labels: ['in-progress'], url: 'https://github.com/danyelf/torahmap/pull/911', lastActivityAt: '2026-11-05T23:00:00Z' }),
      facts({ number: 912, kind: 'issue', labels: ['parked'], url: 'https://github.com/danyelf/torahmap/issues/912', lastActivityAt: '2026-11-05T23:00:00Z' }),
    ], [], NOW));
    expect(html).toMatch(/<a class="num" href="https:\/\/github.com\/danyelf\/torahmap\/pull\/910">PR #910<\/a>/);
    expect(html).toMatch(/<a class="num" href="https:\/\/github.com\/danyelf\/torahmap\/pull\/911">PR #911<\/a>/);
    expect(html).toMatch(/<a class="num" href="https:\/\/github.com\/danyelf\/torahmap\/issues\/912">Issue #912<\/a>/);
  });

  it('groups each section by project, in the order of each project\'s first item', () => {
    const html = renderBoard(buildBoard([
      facts({ repo: 'danyelf/torahmap', number: 920, labels: ['in-progress'], lastActivityAt: '2026-11-05T23:50:00Z' }),
      facts({ repo: 'danyelf/pr-board', number: 2, labels: ['in-progress'], lastActivityAt: '2026-11-05T23:40:00Z' }),
      facts({ repo: 'danyelf/torahmap', number: 921, labels: ['in-progress'], lastActivityAt: '2026-11-05T23:30:00Z' }),
    ], [], NOW));
    const claude = html.slice(html.indexOf('On Claude'), html.indexOf('Quiet:'));
    const order = [...claude.matchAll(/class="proj"[^>]*>([^<]+)<|>(PR #\d+)</g)].map((m) => m[1] ?? m[2]);
    expect(order).toEqual(['torahmap', 'PR #920', 'PR #921', 'pr-board', 'PR #2']);
  });

  it('limits screenshots to four thumbnails, 96 px wide', async () => {
    const shots = Array.from({ length: 6 }, (_, i) => `https://example.com/shot${i}.png`);
    const html = await page([facts({ number: 906, labels: ['on sam'], screenshots: shots, lastActivityAt: '2026-11-05T23:00:00Z' })]);
    expect(html).toContain('shot3.png');
    expect(html).not.toContain('shot4.png');
    expect(html).toContain('width="96"');
  });
});

describe('renderBoard answering', () => {
  const at = '2026-11-05T23:00:00Z';
  const asking = status({ waitingOn: 'owner', questions: [{ n: 1, text: 'Colour?', choices: ['a"b', 'c'], defaultChoice: 'a"b' }] });
  /** The HTML of one card, from its number to the next card. */
  function cardOf(html: string, n: number): string {
    const start = html.lastIndexOf('<div class="card', html.indexOf(`#${n}</a>`));
    const next = html.indexOf('<div class="card', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
  }
  const board = (items: ReturnType<typeof facts>[], opts?: Parameters<typeof renderBoard>[1]) => renderBoard(buildBoard(items, [], NOW), opts);

  it('gives a card with questions a form that posts to /answer, saying which item and what it answers', () => {
    const html = board([facts({ number: 960, repo: 'acme/x', labels: ['on sam'], body: renderStatus(asking), lastActivityAt: at })]);
    const card = cardOf(html, 960);
    expect(card).toContain('<form class="answer" method="post" action="/answer">');
    expect(card).toContain('<input type="hidden" name="repo" value="acme/x">');
    expect(card).toContain('<input type="hidden" name="number" value="960">');
    expect(card).toContain(`<input type="hidden" name="fingerprint" value="${statusFingerprint(asking)}">`);
    expect(card).toContain('<input type="radio" name="q1" value="a&quot;b" checked>');
    expect(card).toContain('<textarea name="note" maxlength="2000"');
  });

  it('asks how it looks on a PR at Your look, after the questions, with looks good checked', () => {
    const html = board([facts({ number: 961, labels: ['on sam'], body: renderStatus(asking), lastActivityAt: at })]);
    const card = cardOf(html, 961);
    expect(card).toContain('How does it look?');
    expect(card.indexOf('How does it look?')).toBeGreaterThan(card.indexOf('Colour?'));
    expect(card).toContain('<label class="btn default"><input type="radio" name="look" value="looks good, prep for merge" checked>');
    expect(card).toContain('<input type="radio" name="look" value="needs changes">');
    expect(card).toContain('<input type="radio" name="look" value="file an issue">');
  });

  it('asks how it looks even when Claude wrote no questions or no status', () => {
    const html = board([facts({ number: 962, labels: ['on sam'], lastActivityAt: at })]);
    expect(cardOf(html, 962)).toContain('name="look"');
  });

  it("doesn't ask how it looks of an issue, or of a PR that has had prep, and gives a card with nothing to ask no form", () => {
    const html = board([
      facts({ number: 963, kind: 'issue', labels: ['on sam'], body: '', statusCommentBody: renderStatus(asking), lastActivityAt: at }),
      facts({ number: 964, labels: ['on sam'], prepDone: true, commitsSincePrep: 0, mergeState: 'CLEAN', lastActivityAt: at }),
    ]);
    expect(cardOf(html, 963)).toContain('name="q1"');
    expect(cardOf(html, 963)).not.toContain('name="look"');
    expect(cardOf(html, 964)).not.toContain('<form');
  });

  it("disables Send, saying why, when answering isn't set up, and enables it when it is", () => {
    const item = facts({ number: 965, labels: ['on sam'], lastActivityAt: at });
    const off = cardOf(board([item]), 965);
    expect(off).toMatch(/<button type="submit" class="btn send" disabled>Send answers<\/button>/);
    expect(off).toContain('Answering isn&#39;t set up yet');
    const on = cardOf(board([item], { answering: true }), 965);
    expect(on).toMatch(/<button type="submit" class="btn send">Send answers<\/button>/);
    expect(on).not.toContain('set up yet');
  });

  it('says what was just sent, escaped', () => {
    const html = board([], { answering: true, sent: 'acme/x#5 <b>' });
    expect(html).toContain('<div class="ok">Sent your answers on acme/x#5 &lt;b&gt;.</div>');
  });

  it('shows answered items on Claude, and one nobody picked up at the top with its answers linked and no form', () => {
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    const answered = (n: number, m: number, claimed: number | null, over: Partial<ReturnType<typeof facts>> = {}) => facts({
      number: n, labels: ['on sam'], lastActivityAt: at,
      answers: [{ id: `c${n}`, url: `https://github.com/acme/x/pull/${n}#issuecomment-1`, at: minutesAgo(m), claimedAt: claimed === null ? null : minutesAgo(claimed) }],
      ...over,
    });
    const html = board([answered(970, 2, null), answered(971, 200, 180), answered(972, 20, null)], { answering: true });
    const claude = html.slice(html.indexOf('On Claude'), html.indexOf('Quiet:'));
    expect(claude).toMatch(/PR #970<\/a>.*answered, waiting for Claude to pick it up<\/span>/);
    expect(claude).toMatch(/PR #971<\/a>.*Claude picked up your answers 3 h ago<\/span>/);
    const card = cardOf(html, 972);
    expect(html.indexOf('PR #972')).toBeLessThan(html.indexOf('On Claude'));
    expect(card).toContain('<span class="why">Answered, not picked up</span>');
    expect(card).toContain('href="https://github.com/acme/x/pull/972#issuecomment-1">Your answers ↗</a>');
    expect(card).not.toContain('<form');
  });

  it('keeps the notes on an answered row: no turn label, label out of sync, and a status older than the latest change', () => {
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    const answers = [{ id: 'c', url: 'https://github.com/acme/x/pull/973#issuecomment-1', at: minutesAgo(2), claimedAt: null }];
    const noLabel = facts({ number: 973, labels: [], body: renderStatus(status({ waitingOn: 'claude' })), lastActivityAt: at, answers });
    const outOfStep = facts({ number: 974, labels: ['in-progress'], body: renderStatus(status({ waitingOn: 'nobody' })), lastActivityAt: at, answers });
    const stale = facts({
      number: 975, labels: ['on sam'], body: renderStatus(status({ waitingOn: 'owner' })), lastActivityAt: at, answers,
      statusWrittenAt: minutesAgo(60), lastChangeAt: minutesAgo(30),
    });
    const html = board([noLabel, outOfStep, stale]);
    const row = (n: number) => html.slice(html.indexOf(`PR #${n}</a>`), html.indexOf('</div>', html.indexOf(`PR #${n}</a>`)));
    expect(row(973)).toContain('answered, waiting for Claude to pick it up · no turn label');
    expect(row(974)).toContain('answered, waiting for Claude to pick it up · label out of sync');
    expect(row(975)).toContain('answered, waiting for Claude to pick it up · status older than latest change');
  });
});
