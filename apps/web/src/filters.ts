import { getParam, getParams, parseRange, rangeToParams, rangeToWindow, type RangeState } from './range';

export type SortKey = 'wasted' | 'count' | 'p95' | 'maxMs';
const SORTS: SortKey[] = ['wasted', 'count', 'p95', 'maxMs'];
export const PAGE_SIZE = 25;
const MAX_LIMIT = 500;

export interface QueryFilters {
  range: RangeState;
  models: string[];
  ops: string[];
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
  return {
    range: parseRange(p),
    models: getParams(p, 'model').filter(Boolean),
    ops: getParams(p, 'op').filter(Boolean),
    sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : 'wasted',
    limit,
  };
}

export function filtersToSearch(f: QueryFilters): string {
  const s = new URLSearchParams(rangeToParams(f.range));
  for (const m of f.models) s.append('model', m);
  for (const o of f.ops) s.append('op', o);
  if (f.sort !== 'wasted') s.set('sort', f.sort);
  if (f.limit !== PAGE_SIZE) s.set('limit', String(f.limit));
  return s.toString();
}

export function filtersToApiQuery(f: QueryFilters, now: Date = new Date()): string {
  const { from, to } = rangeToWindow(f.range, now);
  const s = new URLSearchParams({ from, to, sort: f.sort, limit: String(f.limit) });
  for (const m of f.models) s.append('model', m);
  for (const o of f.ops) s.append('op', o);
  return s.toString();
}
