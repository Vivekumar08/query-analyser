import type { PercentileResult } from '@query-analyser/contract';
import type { QueryRow, SummaryResponse } from './dashboard-types';
import { filtersToSearch, type QueryFilters } from './filters';
import type { ApiResult } from './api';
import { ormLabel, sampledLabel, sourceLabel } from './sources';
import { formatAvg, formatMs, toMs } from './format';

export interface RowView {
  hash: string; title: string; signature: string; count: number;
  wasted: string; wastedShare: number; avg: string;
  p95: PercentileResult | null; max: string;
  source: string; sourceLabel: string; ormLabel: string; errors: number | null; sampledLabel: string | null;
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
    source: r.source ?? 'mongodb',
    sourceLabel: sourceLabel(r.source),
    ormLabel: ormLabel(r.source, r.orm),
    // The SDK never tracks Mongo errors: null, not a false 0.
    errors: (r.source ?? 'mongodb') === 'mongodb' ? null : (r.errors ?? 0),
    sampledLabel: sampledLabel(r.sampleRate),
  }));
}

export function emptyKind(input: { rows: number; filtered: boolean }): 'none' | 'no-data' | 'no-match' {
  if (input.rows > 0) return 'none';
  return input.filtered ? 'no-match' : 'no-data';
}

/** Keeps the time range, drops model/op/source/orm/sort/page. */
export function clearFiltersHref(base: string, f: QueryFilters): string {
  const qs = filtersToSearch({ range: f.range, sort: 'wasted', page: 1 });
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

/** The summary only when the body has the shape the strip reads; anything else (a malformed 200 included) is null. */
export function toSummary(res: ApiResult<SummaryResponse>): SummaryResponse | null {
  if (!res.ok) return null;
  const d = res.data as Partial<SummaryResponse> | null | undefined;
  if (!d || !Array.isArray(d.sources) || typeof d.droppedNew !== 'number' || !Number.isFinite(d.droppedNew)) return null;
  return res.data;
}

/** Runs the summary fetch; a failure or a throw hides the strip and never fails the page. */
export async function loadSummary(fetcher: () => Promise<ApiResult<SummaryResponse>>): Promise<SummaryResponse | null> {
  try {
    return toSummary(await fetcher());
  } catch {
    return null;
  }
}
