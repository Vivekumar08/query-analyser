export type RangePreset = '1h' | '24h' | '7d' | '30d';
export type RangeState =
  | { kind: 'preset'; preset: RangePreset }
  | { kind: 'custom'; from: string; to: string };

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

const PRESET_MS: Record<RangePreset, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};
const DAY_MS = 86_400_000;
/** Each preset's length in days, to compare with the plan's daily retention. */
export const PRESET_DAYS: Record<RangePreset, number> = {
  '1h': 1 / 24,
  '24h': 1,
  '7d': 7,
  '30d': 30,
};

/** Whether the plan keeps enough data to draw this preset in full. */
export function presetAllowed(p: RangePreset, retentionDays: number): boolean {
  return PRESET_DAYS[p] <= retentionDays;
}

/**
 * The first whole UTC day a plan keeping `retentionDays` still has, or null
 * for no limit. The nightly prune deletes daily rows with
 * `day < now - retentionDays` (apps/api/src/analysis/compaction.ts), so the
 * day containing that cutoff is gone unless the cutoff is exactly midnight:
 * the first kept day is the cutoff rounded up to midnight.
 */
export function earliestKeptDay(retentionDays: number, now: Date = new Date()): Date | null {
  if (!Number.isFinite(retentionDays)) return null;
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  return new Date(Math.ceil(cutoff / DAY_MS) * DAY_MS);
}

const DEFAULT: RangeState = { kind: 'preset', preset: '24h' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function getParam(p: Params, key: string): string | undefined {
  if (p instanceof URLSearchParams) return p.get(key) ?? undefined;
  const v = p[key];
  return Array.isArray(v) ? v[0] : v;
}

export function getParams(p: Params, key: string): string[] {
  if (p instanceof URLSearchParams) return p.getAll(key);
  const v = p[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * The range in the URL, limited to what the plan keeps: a preset longer than
 * `retentionDays` falls back to the default rather than drawing a silently
 * partial chart (a bookmarked ?range=30d on a 7-day plan), and a custom range
 * starts no earlier than the first kept day.
 */
export function parseRange(p: Params, retentionDays = Infinity, now: Date = new Date()): RangeState {
  const range = getParam(p, 'range');
  if (range && Object.hasOwn(PRESET_MS, range)) {
    const preset = range as RangePreset;
    return presetAllowed(preset, retentionDays) ? { kind: 'preset', preset } : DEFAULT;
  }
  if (range === 'custom') {
    const from = getParam(p, 'from');
    const to = getParam(p, 'to');
    if (!from || !to || !DAY.test(from) || !DAY.test(to)) return DEFAULT;
    const f = new Date(`${from}T00:00:00.000Z`);
    const t = new Date(`${to}T23:59:59.999Z`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return DEFAULT;
    // Reject calendar-invalid dates such as 2026-02-31, which Date would roll over.
    if (f.toISOString().slice(0, 10) !== from || t.toISOString().slice(0, 10) !== to) return DEFAULT;
    if (f > t) return DEFAULT;
    const earliest = earliestKeptDay(retentionDays, now);
    const start = earliest && f < earliest ? earliest : f;
    if (start > t) return DEFAULT;
    return { kind: 'custom', from: start.toISOString(), to: t.toISOString() };
  }
  return DEFAULT;
}

/**
 * The API window for a range. A preset starts no earlier than the first whole
 * kept day: the API widens a long window's start to UTC midnight, and that
 * day may already be pruned, which would draw a partial first day.
 */
export function rangeToWindow(r: RangeState, now: Date = new Date(), retentionDays = Infinity): { from: string; to: string } {
  if (r.kind === 'custom') return { from: r.from, to: r.to };
  const from = new Date(now.getTime() - PRESET_MS[r.preset]);
  const earliest = earliestKeptDay(retentionDays, now);
  return { from: (earliest && from < earliest ? earliest : from).toISOString(), to: now.toISOString() };
}

export function rangeToParams(r: RangeState): Record<string, string> {
  if (r.kind === 'custom') return { range: 'custom', from: r.from.slice(0, 10), to: r.to.slice(0, 10) };
  return r.preset === '24h' ? {} : { range: r.preset };
}
