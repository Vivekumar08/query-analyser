import { describe, it, expect } from 'vitest';
import { HIST_BOUNDS, HIST_SIZE, bucketOf } from './runtime.js';

describe('histogram constants', () => {
  it('has 7 bounds and 8 buckets', () => {
    expect(HIST_BOUNDS).toEqual([100, 250, 500, 1000, 2500, 5000, 10000]);
    expect(HIST_SIZE).toBe(8);
    expect(HIST_BOUNDS.length).toBe(HIST_SIZE - 1);
  });
});

describe('bucketOf', () => {
  it('formats an hour bucket in UTC', () => {
    expect(bucketOf(new Date('2026-09-20T14:37:09.000Z'))).toBe('2026092014');
  });

  it('zero-pads month, day and hour', () => {
    expect(bucketOf(new Date('2026-01-02T03:00:00.000Z'))).toBe('2026010203');
  });

  it('ignores local timezone', () => {
    // 23:30 UTC is the next day in +05:30, and the previous day in -06:00.
    expect(bucketOf(new Date('2026-09-20T23:30:00.000Z'))).toBe('2026092023');
  });
});
