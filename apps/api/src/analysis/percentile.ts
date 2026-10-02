import { HIST_BOUNDS, HIST_SIZE } from '@query-analyser/contract/runtime';

export type PercentileBasis = 'interpolated' | 'floor';

export interface PercentileResult {
  /** Milliseconds. */
  value: number;
  /**
   * `interpolated` — the rank fell in a bounded bucket and the value is a
   * linear estimate inside it.
   * `floor` — the rank fell in the unbounded top bucket (or there is no data),
   * so the value is the largest observation actually recorded. The real
   * percentile is at least this.
   */
  basis: PercentileBasis;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Approximates a percentile from the fixed 8-bucket histogram.
 *
 * The spec requires the UI to render this as `p95 ≈`. Returning the basis
 * makes the approximation a property of the data rather than a convention a
 * dashboard author has to remember — and lets a floor render as `p95 ≥`.
 *
 * @param p percentile as a fraction, e.g. 0.95
 */
export function percentileFromHist(hist: number[], maxMs: number, p: number): PercentileResult {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return { value: 0, basis: 'floor' };

  const target = p * total;
  let cumulative = 0;

  for (let i = 0; i < HIST_SIZE; i += 1) {
    const inBucket = hist[i] ?? 0;
    if (cumulative + inBucket >= target && inBucket > 0) {
      const lower = i === 0 ? 0 : (HIST_BOUNDS[i - 1] ?? 0);
      const upper = i === HIST_SIZE - 1 ? null : (HIST_BOUNDS[i] ?? 0);

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
