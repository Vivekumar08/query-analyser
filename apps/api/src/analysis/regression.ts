/** A regression is a p95 more than this many times its trailing baseline. */
export const REGRESSION_FACTOR = 2;

/**
 * Minimum observations in the hour before a regression can be reported. One
 * cold query at 3am is not a regression, and without this floor every
 * low-traffic signature alerts constantly.
 */
export const MIN_COUNT = 20;

export interface HourPoint {
  p95: number;
  count: number;
}

export interface RegressionDetail {
  kind: 'regression';
  latestP95: number;
  baselineP95: number;
  factor: number;
  count: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Pure. The caller supplies the trailing window and the last complete hour;
 * this decides whether that constitutes a regression.
 */
export function detectRegression(trailing: HourPoint[], latest: HourPoint): RegressionDetail | null {
  if (trailing.length === 0) return null;
  if (latest.count < MIN_COUNT) return null;

  const baseline = median(trailing.map((h) => h.p95));
  if (baseline <= 0) return null;
  if (latest.p95 <= REGRESSION_FACTOR * baseline) return null;

  return {
    kind: 'regression',
    latestP95: latest.p95,
    baselineP95: baseline,
    factor: Math.round((latest.p95 / baseline) * 100) / 100,
    count: latest.count,
  };
}
