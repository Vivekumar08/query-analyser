import { describe, it, expect } from 'vitest';
import { detectRegression, median, REGRESSION_FACTOR, MIN_COUNT } from './regression.js';

const hour = (p95: number, count = 100) => ({ p95, count });

describe('median', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('takes the middle value for an odd count', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it('is zero for an empty list', () => {
    expect(median([])).toBe(0);
  });
});

describe('detectRegression', () => {
  const trailing = [hour(100), hour(110), hour(90), hour(100), hour(105)];

  it('fires when the latest p95 is more than the factor times the baseline', () => {
    const r = detectRegression(trailing, hour(300));
    expect(r).not.toBeNull();
    expect(r?.kind).toBe('regression');
    expect(r?.baselineP95).toBe(100);
    expect(r?.latestP95).toBe(300);
  });

  it('does not fire at exactly the factor — the rule is strictly greater', () => {
    expect(detectRegression(trailing, hour(100 * REGRESSION_FACTOR))).toBeNull();
  });

  it('does not fire below the count floor, however bad the p95', () => {
    // One cold query at 3am is not a regression. Without this floor every
    // low-traffic signature alerts constantly.
    expect(detectRegression(trailing, hour(5000, MIN_COUNT - 1))).toBeNull();
  });

  it('fires at exactly the count floor', () => {
    expect(detectRegression(trailing, hour(5000, MIN_COUNT))).not.toBeNull();
  });

  it('does not fire with no baseline to regress from', () => {
    expect(detectRegression([], hour(5000))).toBeNull();
  });
});
