import { getParam, getParams, parseRange, rangeToParams, rangeToWindow, type RangeState } from './range';

export type SortKey = 'wasted' | 'count' | 'p95' | 'maxMs';
const SORTS: SortKey[] = ['wasted', 'count', 'p95', 'maxMs'];
export const PAGE_SIZE = 25;
export const MAX_LIMIT = 200;
const MAX_VALUE_LEN = 200;

/** First non-empty value of at most 200 chars, else undefined. */
function firstValue(values: string[]): string | undefined {
  const v = values.find((x) => x.length > 0);
  return v !== undefined && v.length <= MAX_VALUE_LEN ? v : undefined;
}

export interface QueryFilters {
  range: RangeState;
  /** The API takes ONE model and ONE op (each 1..200 chars); repeats are a 400. */
  model?: string;
  op?: string;
  sort: SortKey;
  /** 1-based page of PAGE_SIZE rows. */
  page: number;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

/** `retentionDays` is the plan's daily retention; the range is limited to it (see parseRange). */
export function parseFilters(p: Params, retentionDays?: number): QueryFilters {
  const sort = getParam(p, 'sort');
  const rawPage = getParam(p, 'page');
  const n = rawPage !== undefined && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
  const page = Number.isSafeInteger(n) && n >= 1 ? n : 1;
  const model = firstValue(getParams(p, 'model'));
  const op = firstValue(getParams(p, 'op'));
  return {
    range: parseRange(p, retentionDays),
    ...(model !== undefined && { model }),
    ...(op !== undefined && { op }),
    sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : 'wasted',
    page,
  };
}

export function filtersToSearch(f: QueryFilters): string {
  const s = new URLSearchParams(rangeToParams(f.range));
  if (f.model) s.set('model', f.model);
  if (f.op) s.set('op', f.op);
  if (f.sort !== 'wasted') s.set('sort', f.sort);
  if (f.page > 1) s.set('page', String(f.page));
  return s.toString();
}

export function filtersToApiQuery(f: QueryFilters, now: Date = new Date()): string {
  const { from, to } = rangeToWindow(f.range, now);
  const s = new URLSearchParams({ from, to, sort: f.sort, limit: String(PAGE_SIZE), offset: String((f.page - 1) * PAGE_SIZE) });
  if (f.model) s.set('model', f.model);
  if (f.op) s.set('op', f.op);
  return s.toString();
}

/** Unfiltered top-by-wasted window used to fill the model/op dropdowns. */
export function optionsApiQuery(range: RangeState, now: Date = new Date()): string {
  const { from, to } = rangeToWindow(range, now);
  return new URLSearchParams({ from, to, sort: 'wasted', limit: String(MAX_LIMIT) }).toString();
}
