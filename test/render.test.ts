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

  it('limits screenshots to four thumbnails, 96 px wide', async () => {
    const shots = Array.from({ length: 6 }, (_, i) => `https://example.com/shot${i}.png`);
    const html = await page([facts({ number: 906, labels: ['on danyel'], screenshots: shots, lastActivityAt: '2026-11-05T23:00:00Z' })]);
    expect(html).toContain('shot3.png');
    expect(html).not.toContain('shot4.png');
    expect(html).toContain('width="96"');
  });
});
