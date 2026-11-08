import { describe, expect, it } from 'vitest';
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

  it('draws questions as disabled buttons with the default emphasised and a last file-an-issue choice', async () => {
    const html = await page();
    expect(html).toMatch(/<button[^>]*class="[^"]*\bdefault\b[^"]*"[^>]*>leave<\/button>/);
    expect(html).toContain('file an issue');
    expect(html).toContain('title="Answering comes next"');
    expect(html).not.toMatch(/<button(?![^>]*disabled)/);
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
