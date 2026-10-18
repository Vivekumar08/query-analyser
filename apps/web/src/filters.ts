import { getParam, getParams, parseRange, rangeToParams, rangeToWindow, type RangeState } from './range';

export type SortKey = 'wasted' | 'count' | 'p95' | 'maxMs';
const SORTS: SortKey[] = ['wasted', 'count', 'p95', 'maxMs'];
export const PAGE_SIZE = 25;
export const MAX_LIMIT = 500;
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
  limit: number;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

export function parseFilters(p: Params): QueryFilters {
  const sort = getParam(p, 'sort');
  const rawLimit = Number(getParam(p, 'limit'));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIMIT, Math.ceil(rawLimit / PAGE_SIZE) * PAGE_SIZE)
    : PAGE_SIZE;
  const model = firstValue(getParams(p, 'model'));
  const op = firstValue(getParams(p, 'op'));
  return {
    range: parseRange(p),
    ...(model !== undefined && { model }),
    ...(op !== undefined && { op }),
    sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : 'wasted',
    limit,
  };
}

export function filtersToSearch(f: QueryFilters): string {
  const s = new URLSearchParams(rangeToParams(f.range));
  if (f.model) s.set('model', f.model);
  if (f.op) s.set('op', f.op);
  if (f.sort !== 'wasted') s.set('sort', f.sort);
  if (f.limit !== PAGE_SIZE) s.set('limit', String(f.limit));
  return s.toString();
}

export function filtersToApiQuery(f: QueryFilters, now: Date = new Date()): string {
  const { from, to } = rangeToWindow(f.range, now);
  const s = new URLSearchParams({ from, to, sort: f.sort, limit: String(f.limit) });
  if (f.model) s.set('model', f.model);
  if (f.op) s.set('op', f.op);
  return s.toString();
}

/** 'more' when a further page may exist, 'capped' at the hard row cap, else 'none'. */
export function showMore(rows: readonly unknown[], limit: number): 'more' | 'capped' | 'none' {
  if (rows.length !== limit) return 'none';
  return limit < MAX_LIMIT ? 'more' : 'capped';
}
