import { HIST_BOUNDS, FINE_HIST_BOUNDS, FINE_HIST_SIZE } from '@query-analyser/contract/runtime';
import type { PercentileBasis, PercentileResult } from '@query-analyser/contract';

export type { PercentileBasis, PercentileResult };

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Approximates a percentile from the fixed 8-bucket histogram.
 *
 * The spec requires the UI to render this as `p95 ≈`. Returning the basis
 * makes the approximation a property of the data rather than a convention a
 * dashboard author has to remember — and lets a floor render as `p95 ≥`.
 *
 * @param p percentile as a fraction, e.g. 0.95
 * @param bounds upper bounds of every bucket but the last; `HIST_BOUNDS` (8 buckets) or `FINE_HIST_BOUNDS` (14)
 */
export function percentileFromHist(
  hist: number[],
  maxMs: number,
  p: number,
  bounds: readonly number[] = HIST_BOUNDS,
): PercentileResult {
  const size = bounds.length + 1;
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return { value: 0, basis: 'floor' };

  const target = p * total;
  let cumulative = 0;

  for (let i = 0; i < size; i += 1) {
    const inBucket = hist[i] ?? 0;
    if (cumulative + inBucket >= target && inBucket > 0) {
      const lower = i === 0 ? 0 : (bounds[i - 1] ?? 0);
      const upper = i === size - 1 ? null : (bounds[i] ?? 0);

      // The top bucket has no upper bound. Interpolating toward infinity is
      // meaningless, so report the largest value actually observed.
      if (upper === null) return { value: maxMs, basis: 'floor' };

      const within = (target - cumulative) / inBucket;
      const estimate = lower + (upper - lower) * within;

      // Interpolation can overshoot: ten queries all under 50ms still put p95
      // at 95ms by arithmetic alone. Never report a number nobody measured.
      return { value: round2(Math.min(estimate, maxMs)), basis: 'interpolated' };
    }
    cumulative += inBucket;
  }

  return { value: maxMs, basis: 'floor' };
}

/** `totalMs / count`, as a number. `totalMs` arrives as a BigInt from Prisma. */
export function avgMs(totalMs: bigint | number, count: number): number {
  if (count === 0) return 0;
  return round2(Number(totalMs) / count);
}

/** `histFine` when it has 14 buckets, else the coarse `hist` with `HIST_BOUNDS`. */
export function percentiles(
  hist: number[],
  histFine: number[] | null,
  maxMs: number,
): { p50: PercentileResult; p95: PercentileResult; p99: PercentileResult } {
  const fine = histFine !== null && histFine.length === FINE_HIST_SIZE;
  const h = fine ? histFine : hist;
  const b = fine ? FINE_HIST_BOUNDS : HIST_BOUNDS;
  return {
    p50: percentileFromHist(h, maxMs, 0.5, b),
    p95: percentileFromHist(h, maxMs, 0.95, b),
    p99: percentileFromHist(h, maxMs, 0.99, b),
  };
}
