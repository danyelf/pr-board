import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/shared/timeline.ts';
import { facts, status } from './helpers.ts';
import { renderStatus } from '../src/shared/status.ts';

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-05T20:00:00Z');
const dense = (from: number, to: number) => {
  const out: string[] = [];
  for (let t = from; t <= to; t += 6 * H) out.push(iso(t));
  return out;
};

describe('buildTimeline', () => {
  it('has no cuts and linear positions when nothing is quiet for a day', () => {
    const a = facts({ number: 1, createdAt: iso(NOW - 48 * H), activityTimes: [iso(NOW - 48 * H), iso(NOW - 24 * H - 1000), iso(NOW - 1000)] });
    const b = facts({ number: 2, createdAt: iso(NOW - 36 * H), activityTimes: [iso(NOW - 36 * H), iso(NOW - 12 * H)] });
    const t = buildTimeline([a, b], new Date(NOW), 2);
    expect(t.cuts).toEqual([]);
    expect(t.lanes).toHaveLength(2);
    expect(t.lanes[0].segments[0].start).toBe(0);
    expect(t.lanes[1].segments[0].start).toBeCloseTo(0.25, 5);
    expect(t.lanes[1].segments[0].end).toBeCloseTo(1, 5);
    expect(t.lanes[1].label).toBe('#2 t');
  });

  it('cuts a 38 h quiet stretch', () => {
    const start = NOW - 4 * 24 * H;
    const quietStart = start + 18 * H;
    const quietEnd = quietStart + 38 * H;
    const item = facts({
      createdAt: iso(start - H),
      activityTimes: [...dense(start, quietStart), ...dense(quietEnd, NOW)],
    });
    const t = buildTimeline([item], new Date(NOW), 4);
    expect(t.cuts).toHaveLength(1);
    expect(t.cuts[0].length).toBe('1 d 14 h');
    expect(t.cuts[0].width).toBe(0.03);
  });

  it('labels a 40 h waiting bar across a 38 h cut as waited 1 d 16 h', () => {
    const start = NOW - 3 * 24 * H;
    const waitFrom = start + 10 * H;
    const item = facts({
      createdAt: iso(start - H),
      labels: ['on danyel'],
      labelEvents: [{ label: 'on danyel', action: 'added', at: iso(waitFrom) }],
      activityTimes: [iso(start), iso(waitFrom - 4 * H), iso(waitFrom), iso(waitFrom + 1 * H), iso(waitFrom + 39 * H), iso(NOW - 1000)],
    });
    // quiet from waitFrom+1h to waitFrom+39h (38 h); waiting runs from waitFrom to now
    const t = buildTimeline([item], new Date(NOW), 3);
    expect(t.cuts.map((c) => c.length)).toEqual(['1 d 14 h']);
    const seg = t.lanes[0].segments.find((s) => s.kind === 'waiting')!;
    expect(seg.trueLength).toBe(`waited ${Math.floor((NOW - waitFrom) / H / 24)} d ${Math.floor((NOW - waitFrom) / H) % 24} h`);
  });

  it('cuts exactly 24 h but not 23 h 59 m', () => {
    const start = NOW - 3 * 24 * H;
    const mk = (gap: number) =>
      facts({ createdAt: iso(start), activityTimes: [...dense(start, start + 12 * H), ...dense(start + 12 * H + gap, NOW)] });
    expect(buildTimeline([mk(24 * H)], new Date(NOW), 3).cuts.map((c) => c.length)).toEqual(['1 d 0 h']);
    expect(buildTimeline([mk(24 * H - 60_000)], new Date(NOW), 3).cuts).toEqual([]);
  });

  it('starts at 0 for an item created before the window', () => {
    const item = facts({ createdAt: iso(NOW - 30 * 24 * H), activityTimes: [iso(NOW - 2 * H)] });
    const t = buildTimeline([item], new Date(NOW), 1);
    expect(t.lanes[0].segments[0].start).toBe(0);
  });

  it('puts ticks at true local midnights across the end of daylight saving', () => {
    const now = Date.parse('2026-11-02T20:00:00Z');
    const start = now - 3 * 24 * H;
    const times = Array.from({ length: 16 }, (_, i) => iso(start + i * 4.5 * H));
    const item = facts({ createdAt: iso(start), activityTimes: times });
    const t = buildTimeline([item], new Date(now), 3);
    const texts = t.ticks.map((x) => x.text);
    expect(texts).toContain('Sun 0:00');
    expect(texts).toContain('Mon 0:00');
    expect(t.cuts).toEqual([]);
    const total = 3 * 24 * H;
    const sun = Date.parse('2026-11-01T07:00:00Z');
    const mon = Date.parse('2026-11-02T08:00:00Z');
    const at = (s: string) => t.ticks.find((x) => x.text === s)!.at;
    expect(at('Sun 0:00')).toBeCloseTo((sun - start) / total, 5);
    expect(at('Mon 0:00')).toBeCloseTo((mon - start) / total, 5);
  });

  it('always ticks the window start and the far edge of each cut, in Pacific time', () => {
    const start = NOW - 4 * 24 * H;
    const quietStart = start + 18 * H;
    const quietEnd = quietStart + 38 * H;
    const item = facts({
      createdAt: iso(start - H),
      activityTimes: [...dense(start, quietStart), ...dense(quietEnd, NOW)],
    });
    const t = buildTimeline([item], new Date(NOW), 4);
    // start is 2026-11-01T20:00Z, which is noon on Sunday in Pacific standard time
    expect(t.ticks[0]).toEqual({ at: 0, text: 'Sun 12 pm' });
    const edge = t.ticks.find((x) => x.at > 0 && x.text !== t.ticks[0].text && !x.text.endsWith('0:00'))!;
    expect(edge.at).toBeCloseTo(t.cuts[0].at + t.cuts[0].width, 5);
    expect(edge.text).toMatch(/^\w{3} \d{1,2}(:\d\d)? [ap]m$/);
  });

  it('drops a midnight tick within 0.04 of a reference tick', () => {
    const start = Date.parse('2026-11-03T07:30:00Z'); // just after local midnight
    const now = start + 2 * 24 * H;
    const item = facts({ createdAt: iso(start), activityTimes: [iso(start), iso(start + 12 * H), iso(start + 24 * H), iso(now)] });
    const t = buildTimeline([item], new Date(now), 2);
    expect(t.ticks[0].at).toBe(0);
    expect(t.ticks.filter((x) => x.at < 0.04)).toHaveLength(1);
  });

  it('handles no items', () => {
    const t = buildTimeline([], new Date(NOW));
    expect(t.lanes).toEqual([]);
    expect(t.openCount.every((o) => o.n === 0)).toBe(true);
  });

  it('shows a PR with steady commits and no labels as one unlabelled bar with no cuts', () => {
    const start = NOW - 2 * 24 * H;
    const times = Array.from({ length: 12 }, (_, i) => iso(start + i * 4 * H));
    times.push(iso(NOW - H));
    const item = facts({ createdAt: iso(start), activityTimes: times });
    const t = buildTimeline([item], new Date(NOW), 2);
    expect(t.cuts).toEqual([]);
    expect(t.lanes[0].segments).toHaveLength(1);
    expect(t.lanes[0].segments[0].kind).toBe('unlabelled');
  });

  it('ends an in-progress item waiting when the status says Danyel', () => {
    const since = iso(NOW - 6 * H);
    const item = facts({
      createdAt: iso(NOW - 20 * H),
      labels: ['in-progress'],
      labelEvents: [{ label: 'in-progress', action: 'added', at: iso(NOW - 19 * H) }],
      body: renderStatus(status({ waitingOn: 'Danyel', since })),
      activityTimes: [iso(NOW - 20 * H), iso(NOW - 6 * H)],
    });
    const t = buildTimeline([item], new Date(NOW), 1);
    const segs = t.lanes[0].segments;
    expect(segs[0].kind).toBe('unlabelled');
    expect(segs[1].kind).toBe('working');
    expect(segs[segs.length - 1].kind).toBe('waiting');
    expect(segs[segs.length - 1].end).toBe(1);
    expect(segs[segs.length - 1].start).toBeCloseTo(0.75, 2);
  });

  it('shows one merged segment for a quick merge and drops items outside the window', () => {
    const quick = facts({ number: 5, merged: true, createdAt: iso(NOW - 5 * H), mergedAt: iso(NOW - 2 * H), closedAt: iso(NOW - 2 * H), activityTimes: [iso(NOW - 5 * H), iso(NOW - 2 * H)] });
    const old = facts({ number: 6, merged: true, createdAt: iso(NOW - 50 * 24 * H), mergedAt: iso(NOW - 40 * 24 * H), activityTimes: [iso(NOW - 40 * 24 * H)] });
    const t = buildTimeline([quick, old], new Date(NOW), 1);
    expect(t.lanes).toHaveLength(1);
    expect(t.lanes[0].segments.map((s) => s.kind)).toEqual(['merged']);
  });

  it('counts still-open items at the final sample and drops merged ones after they merge', () => {
    const open = facts({ number: 1, createdAt: iso(NOW - 10 * H), activityTimes: [iso(NOW - 10 * H), iso(NOW - 5 * H)] });
    const merged = facts({
      number: 2, merged: true, createdAt: iso(NOW - 20 * H), mergedAt: iso(NOW - 8 * H), closedAt: iso(NOW - 8 * H),
      activityTimes: [iso(NOW - 20 * H), iso(NOW - 8 * H)],
    });
    const t = buildTimeline([open, merged], new Date(NOW), 1);
    // instants: window start, -20h, -10h, -8h, -5h, now
    expect(t.openCount.map((o) => o.n)).toEqual([0, 1, 2, 1, 1, 1]);
    expect(t.openCount[t.openCount.length - 1].at).toBe(1);
  });

  it('reports the full real length of a bar that began before the window', () => {
    const start = NOW - 3 * 24 * H;
    const waitFrom = NOW - 5 * 24 * H;
    const item = facts({
      createdAt: iso(waitFrom - H),
      labels: ['on danyel'],
      labelEvents: [{ label: 'on danyel', action: 'added', at: iso(waitFrom) }],
      activityTimes: [iso(waitFrom), ...dense(start, start + 12 * H), ...dense(NOW - 12 * H, NOW)],
    });
    const t = buildTimeline([item], new Date(NOW), 3);
    expect(t.cuts).toHaveLength(1);
    expect(t.lanes[0].segments[0].trueLength).toBe('waited 5 d 0 h');
  });
});
