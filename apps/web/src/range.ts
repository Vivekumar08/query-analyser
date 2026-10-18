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

export function parseRange(p: Params): RangeState {
  const range = getParam(p, 'range');
  if (range && range in PRESET_MS) return { kind: 'preset', preset: range as RangePreset };
  if (range === 'custom') {
    const from = getParam(p, 'from');
    const to = getParam(p, 'to');
    if (!from || !to || !DAY.test(from) || !DAY.test(to)) return DEFAULT;
    const f = new Date(`${from}T00:00:00.000Z`);
    const t = new Date(`${to}T23:59:59.999Z`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f > t) return DEFAULT;
    return { kind: 'custom', from: f.toISOString(), to: t.toISOString() };
  }
  return DEFAULT;
}

export function rangeToWindow(r: RangeState, now: Date = new Date()): { from: string; to: string } {
  if (r.kind === 'custom') return { from: r.from, to: r.to };
  return { from: new Date(now.getTime() - PRESET_MS[r.preset]).toISOString(), to: now.toISOString() };
}

export function rangeToParams(r: RangeState): Record<string, string> {
  if (r.kind === 'custom') return { range: 'custom', from: r.from.slice(0, 10), to: r.to.slice(0, 10) };
  return r.preset === '24h' ? {} : { range: r.preset };
}
