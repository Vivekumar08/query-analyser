import type { PercentileResult } from '@query-analyser/contract';
import type { QueryRow } from './dashboard-types';
import { filtersToSearch, PAGE_SIZE, type QueryFilters } from './filters';
import type { ApiResult } from './api';
import { formatAvg, formatMs, toMs } from './format';

export interface RowView {
  hash: string; title: string; signature: string; count: number;
  wasted: string; wastedShare: number; avg: string;
  p95: PercentileResult | null; max: string;
}

export function toRowsView(rows: QueryRow[]): RowView[] {
  const totals = rows.map((r) => toMs(r.totalMs));
  const top = Math.max(0, ...totals);
  return rows.map((r, i) => ({
    hash: r.hash,
    title: `${r.model}.${r.operation}`,
    signature: r.signature,
    count: r.count,
    wasted: formatMs(totals[i]!),
    wastedShare: top > 0 ? totals[i]! / top : 0,
    avg: formatAvg(r.totalMs, r.count),
    p95: r.p95 ?? null,
    max: formatMs(r.maxMs),
  }));
}

export function emptyKind(input: { rows: number; filtered: boolean }): 'none' | 'no-data' | 'no-match' {
  if (input.rows > 0) return 'none';
  return input.filtered ? 'no-match' : 'no-data';
}

/** Keeps the time range, drops model/op/sort/limit. */
export function clearFiltersHref(base: string, f: QueryFilters): string {
  const qs = filtersToSearch({ range: f.range, sort: 'wasted', limit: PAGE_SIZE });
  return `${base}/queries${qs ? `?${qs}` : ''}`;
}

/**
 * The list route 400s on bad filters (e.g. an over-long model); that renders
 * inline. Every other failure still goes to the error boundary.
 */
export function listOutcome(res: ApiResult<unknown>): 'ok' | 'invalid-filters' | 'error' {
  if (res.ok) return 'ok';
  return res.status === 400 ? 'invalid-filters' : 'error';
}
