import { describe, expect, it } from 'vitest';
import { buildBoard } from '../src/worker/board.ts';
import { renderBoard } from '../src/worker/render.ts';
import { facts } from './helpers.ts';
import { NOW, boardItems } from './board-items.ts';

async function page(extra = [] as ReturnType<typeof facts>[], errors: string[] = []): Promise<string> {
  const items = [...(await boardItems()), ...extra];
  return renderBoard(buildBoard(items, errors, NOW));
}

describe('renderBoard', () => {
  it('shows each waiting card with its number, why tag, preview and test protocol', async () => {
    const html = await page();
    expect(html).toContain('#573');
    expect(html).toContain('Only your look is left');
    expect(html).toContain('panels-unchanged-torahmap.danyel.workers.dev');
    expect(html).toContain('search for a word, open the search panel, pin a verse');
  });

  it('says so when no status has been written', async () => {
    expect(await page([facts({ number: 900, labels: ['on danyel'],lastActivityAt: '2026-11-05T23:00:00Z' })])).toContain('No status written yet');
  });

  it('flags a label that disagrees with the status', async () => {
    expect(await page()).toContain('label out of sync');
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

  it('has no timeline section', async () => {
    expect(await page([])).not.toContain('The last 7 days');
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
    const body = '<!-- status -->\n**Waiting on:** Danyel, since yesterday afternoon\n<!-- /status -->';
    const html = await page([facts({ number: 907, labels: ['on danyel'], body, lastActivityAt: '2026-11-05T23:00:00Z' })]);
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
      number: 905, url: 'https://github.com/danyelf/torahmap/pull/905', labels: ['on danyel'],
      prepDone: true, commitsSincePrep: 0, mergeState: 'CLEAN', lastActivityAt: '2026-11-05T23:00:00Z',
    });
    const html = await page([ready]);
    expect(html).toContain('Merge on GitHub');
    expect(html).toContain('href="https://github.com/danyelf/torahmap/pull/905"');
  });

  it('links every number to GitHub and says whether it is a PR or an issue', () => {
    const html = renderBoard(buildBoard([
      facts({ number: 910, labels: ['on danyel'], url: 'https://github.com/danyelf/torahmap/pull/910', lastActivityAt: '2026-11-05T23:00:00Z' }),
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
    const html = await page([facts({ number: 906, labels: ['on danyel'], screenshots: shots, lastActivityAt: '2026-11-05T23:00:00Z' })]);
    expect(html).toContain('shot3.png');
    expect(html).not.toContain('shot4.png');
    expect(html).toContain('width="96"');
  });
});
