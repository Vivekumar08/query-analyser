import { describe, it, expect } from 'vitest';
import { percentileFromHist, avgMs } from './percentile.js';

describe('percentileFromHist', () => {
  it('returns zero for an empty histogram', () => {
    expect(percentileFromHist([0, 0, 0, 0, 0, 0, 0, 0], 0, 0.95)).toEqual({
      value: 0,
      basis: 'floor',
    });
  });

  it('interpolates inside the first bucket', () => {
    // 10 observations, all in [0,100). p50 -> rank 5 -> halfway -> 50ms.
    const r = percentileFromHist([10, 0, 0, 0, 0, 0, 0, 0], 80, 0.5);
    expect(r.basis).toBe('interpolated');
    expect(r.value).toBe(50);
  });

  it('never reports a percentile above the observed maximum', () => {
    // Interpolation alone would give 95ms, but nothing slower than 50ms was
    // ever seen. Reporting 95 would be inventing a measurement.
    const r = percentileFromHist([10, 0, 0, 0, 0, 0, 0, 0], 50, 0.95);
    expect(r.value).toBe(50);
  });

  it('interpolates inside a middle bucket', () => {
    // 10 in [0,100), 10 in [250,500). p95 -> rank 19 -> 9th of the 10 in
    // bucket 2 -> 250 + 0.9 * 250 = 475.
    const r = percentileFromHist([10, 0, 10, 0, 0, 0, 0, 0], 600, 0.95);
    expect(r.basis).toBe('interpolated');
    expect(r.value).toBe(475);
  });

  it('reports a floor, not an estimate, when the rank lands in the unbounded top bucket', () => {
    // The last bucket is [10000, infinity) — there is no upper bound to
    // interpolate toward, so the honest answer is the largest value actually
    // observed.
    const r = percentileFromHist([0, 0, 0, 0, 0, 0, 0, 5], 14002, 0.95);
    expect(r).toEqual({ value: 14002, basis: 'floor' });
  });

  it('handles a rank landing exactly on a bucket boundary', () => {
    const r = percentileFromHist([10, 10, 0, 0, 0, 0, 0, 0], 400, 0.5);
    expect(r.value).toBe(100);
  });
});

describe('avgMs', () => {
  it('divides totalMs by count', () => {
    expect(avgMs(900n, 4)).toBe(225);
  });

  it('is zero for a count of zero rather than NaN or Infinity', () => {
    expect(avgMs(0n, 0)).toBe(0);
  });

  it('rounds to two decimals', () => {
    expect(avgMs(100n, 3)).toBe(33.33);
  });
});
