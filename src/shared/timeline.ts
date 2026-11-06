import type { ItemFacts } from './types.ts';
import { parseStatus } from './status.ts';
import { effectiveTurn, formatWait, isReadyToMerge } from './turn.ts';

export type SegKind = 'working' | 'waiting' | 'ready' | 'parked' | 'merged' | 'unlabelled';
export interface Segment { kind: SegKind; start: number; end: number; trueLength?: string } // 0..1 across the axis
export interface Lane { label: string; url: string; segments: Segment[] }
export interface Cut { at: number; width: number; length: string }
export interface Tick { at: number; text: string }
export interface Timeline { lanes: Lane[]; cuts: Cut[]; ticks: Tick[]; openCount: { at: number; n: number }[] }

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CUT_WIDTH = 0.03;
const QUICK_MERGE = 6 * HOUR;
const LABEL_LENGTH = 40;

interface RawSegment { kind: SegKind; start: number; end: number }
interface CutSpan { start: number; end: number }

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function kindFor(on: Set<string>): SegKind {
  if (on.has('on danyel')) return 'waiting';
  if (on.has('parked')) return 'parked';
  if (on.has('in-progress')) return 'working';
  return 'unlabelled';
}

function itemEnd(f: ItemFacts, now: number): number {
  return ms(f.mergedAt ?? f.closedAt ?? new Date(now).toISOString());
}

function statusOf(f: ItemFacts) {
  return parseStatus(f.kind === 'pr' ? f.body : f.statusCommentBody ?? '');
}

/**
 * `alsoWaiting` is set when the item counts as waiting on Danyel for a reason its own labels and
 * status don't show (an issue it stands in for is waiting); the value is when that wait started, if known.
 */
function rawSegments(f: ItemFacts, now: number, alsoWaiting?: string | null): RawSegment[] {
  const created = ms(f.createdAt);
  const end = itemEnd(f, now);
  if (f.merged && f.mergedAt && end - created < QUICK_MERGE) {
    return [{ kind: 'merged', start: created, end }];
  }

  const events = [...f.labelEvents].sort((a, b) => ms(a.at) - ms(b.at));
  const on = new Set<string>();
  const segs: RawSegment[] = [];
  let cursor = created;
  for (const e of events) {
    const at = Math.min(Math.max(ms(e.at), created), end);
    if (at > cursor) segs.push({ kind: kindFor(on), start: cursor, end: at });
    cursor = Math.max(cursor, at);
    if (e.action === 'added') on.add(e.label);
    else on.delete(e.label);
  }
  if (end > cursor) segs.push({ kind: kindFor(on), start: cursor, end });

  const open = !f.merged && f.closedAt === null;
  if (open) {
    const s = statusOf(f);
    const ready = isReadyToMerge(f, s);
    if (on.has('on danyel')) {
      const last = segs[segs.length - 1];
      if (ready && last?.kind === 'waiting') last.kind = 'ready';
    } else if (effectiveTurn(f.labels, s).turn === 'danyel' || alsoWaiting !== undefined) {
      const ownTurn = effectiveTurn(f.labels, s).turn === 'danyel';
      const since = ownTurn ? s?.since ?? f.lastActivityAt : alsoWaiting ?? f.lastActivityAt;
      const from = Math.min(Math.max(ms(since), created), end);
      const kept: RawSegment[] = [];
      for (const seg of segs) {
        if (seg.start >= from) continue;
        kept.push({ ...seg, end: Math.min(seg.end, from) });
      }
      if (end > from) kept.push({ kind: ready ? 'ready' : 'waiting', start: from, end });
      return merge(kept);
    }
  }
  return merge(segs);
}

function merge(segs: RawSegment[]): RawSegment[] {
  const out: RawSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind && last.end === s.start) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

function laterOf(a: number, b: number): number {
  return a > b ? a : b;
}

const LA = { timeZone: 'America/Los_Angeles' } as const;
const dateParts = new Intl.DateTimeFormat('en-US', { ...LA, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
const weekday = new Intl.DateTimeFormat('en-US', { ...LA, weekday: 'short' });

const clock = new Intl.DateTimeFormat('en-US', { ...LA, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: true });

function clockLabel(t: number): string {
  const p = Object.fromEntries(clock.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const minutes = p.minute === '00' ? '' : `:${p.minute}`;
  return `${p.weekday} ${p.hour}${minutes} ${String(p.dayPeriod).toLowerCase()}`;
}

function localParts(t: number): { y: number; m: number; d: number; h: number; min: number } {
  const p = Object.fromEntries(dateParts.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute };
}

function localMidnights(start: number, end: number): number[] {
  const first = localParts(start);
  const out: number[] = [];
  // Walk calendar days; each local midnight is 07:00 or 08:00 UTC depending on daylight saving.
  for (let day = 0; day < 400; day++) {
    const base = Date.UTC(first.y, first.m - 1, first.d + day);
    if (base > end + DAY) break;
    for (const offset of [7 * HOUR, 8 * HOUR]) {
      const t = base + offset;
      const p = localParts(t);
      if (p.h === 0 && p.min === 0 && p.d === new Date(base).getUTCDate() && t >= start && t <= end) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * `alsoWaiting` names items (as "owner/repo#N") that count as waiting on Danyel although their own
 * labels and status don't say so, with when that wait started if known.
 */
export function buildTimeline(items: ItemFacts[], now: Date, days = 7, alsoWaiting: Map<string, string | null> = new Map()): Timeline {
  const nowMs = now.getTime();
  const start = nowMs - days * DAY;

  const inWindow = items.filter((f) => ms(f.createdAt) <= nowMs && itemEnd(f, nowMs) >= start);

  const instants = new Set<number>([start, nowMs]);
  for (const f of inWindow) {
    for (const a of f.activityTimes) {
      const t = ms(a);
      if (t >= start && t <= nowMs) instants.add(t);
    }
  }
  const sorted = [...instants].sort((a, b) => a - b);

  const cutSpans: CutSpan[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] >= DAY) cutSpans.push({ start: sorted[i - 1], end: sorted[i] });
  }
  const cutTotal = cutSpans.reduce((n, c) => n + (c.end - c.start), 0);
  const realTotal = nowMs - start - cutTotal;
  const realShare = 1 - CUT_WIDTH * cutSpans.length;

  function pos(time: number): number {
    const t = Math.min(Math.max(time, start), nowMs);
    let real = 0;
    let cutsBefore = 0;
    let prev = start;
    for (const c of cutSpans) {
      if (t <= c.start) break;
      real += c.start - prev;
      if (t < c.end) {
        return cutsBefore * CUT_WIDTH + (real / realTotal) * realShare + ((t - c.start) / (c.end - c.start)) * CUT_WIDTH;
      }
      cutsBefore++;
      prev = c.end;
    }
    real += t - prev;
    return cutsBefore * CUT_WIDTH + (realTotal > 0 ? (real / realTotal) * realShare : 0);
  }

  const lanes: Lane[] = inWindow.map((f) => {
    const segments: Segment[] = [];
    const key = `${f.repo}#${f.number}`;
    for (const raw of rawSegments(f, nowMs, alsoWaiting.has(key) ? alsoWaiting.get(key)! : undefined)) {
      const s = laterOf(raw.start, start);
      const e = Math.min(raw.end, nowMs);
      if (e <= s) continue;
      const seg: Segment = { kind: raw.kind, start: pos(s), end: pos(e) };
      const crossesCut = cutSpans.some((c) => s < c.end && e > c.start);
      if (crossesCut && e - s >= DAY) {
        const length = formatWait(new Date(raw.start).toISOString(), new Date(raw.end));
        seg.trueLength = raw.kind === 'waiting' ? `waited ${length}` : length;
      }
      segments.push(seg);
    }
    return { label: `#${f.number} ${f.title}`.slice(0, LABEL_LENGTH), url: f.url, segments };
  });

  const cuts: Cut[] = cutSpans.map((c) => ({
    at: pos(c.start),
    width: CUT_WIDTH,
    length: formatWait(new Date(c.start).toISOString(), new Date(c.end)),
  }));

  // Reference ticks: the window start and where every cut ends, so the axis always says what time it is.
  const anchors: Tick[] = [start, ...cutSpans.map((c) => c.end)].map((t) => ({ at: pos(t), text: clockLabel(t) }));
  const midnights: Tick[] = localMidnights(start, nowMs)
    .filter((t) => !cutSpans.some((c) => t > c.start && t < c.end))
    .map((t) => ({ at: pos(t), text: `${weekday.format(new Date(t))} 0:00` }))
    .filter((m) => !anchors.some((a) => Math.abs(a.at - m.at) < 0.04));
  const ticks: Tick[] = [...anchors, ...midnights].sort((a, b) => a.at - b.at);

  const openCount = sorted.map((t) => ({
    at: pos(t),
    n: inWindow.filter((f) => {
      const ended = f.mergedAt ?? f.closedAt;
      return ms(f.createdAt) <= t && (ended === null || ms(ended) > t);
    }).length,
  }));

  return { lanes, cuts, ticks, openCount };
}
