import { describe, it, expect } from 'vitest';
import { createIndexCall, histogramData, trendData } from './detail-view';

describe('createIndexCall', () => {
  it('keeps field order and direction', () =>
    expect(createIndexCall('Order', [{ field: 'email', dir: 1 }, { field: 'total', dir: -1 }]))
      .toBe('Order.collection.createIndex({ email: 1, total: -1 })'));
  it('quotes dotted or unusual field names', () =>
    expect(createIndexCall('User', [{ field: 'address.city', dir: 1 }])).toBe(`User.collection.createIndex({ "address.city": 1 })`));
  it('keeps _id as a plain identifier sort key', () =>
    expect(createIndexCall('User', [{ field: 'email', dir: 1 }, { field: '_id', dir: -1 }]))
      .toBe('User.collection.createIndex({ email: 1, _id: -1 })'));
});

describe('histogramData', () => {
  it('pairs counts with labels', () => {
    const d = histogramData([0, 3, 1, 0, 0, 0, 0, 2]);
    expect(d[1]).toEqual({ bucket: '100–250ms', count: 3 });
    expect(d[7]).toEqual({ bucket: '≥ 10s', count: 2 });
  });
});

describe('trendData', () => {
  it('hourly labels and p95 in ms (null for an empty bucket, whose p95 is a meaningless 0)', () => {
    const d = trendData([
      { at: '2026-10-18T09:00:00.000Z', count: 4, totalMs: '400', maxMs: 200, avgMs: 100, p95: { value: 180, basis: 'interpolated' } },
      { at: '2026-10-18T10:00:00.000Z', count: 0, totalMs: '0', maxMs: 0, avgMs: 0, p95: { value: 0, basis: 'floor' } },
    ], 'hourly');
    expect(d[0]).toMatchObject({ label: '09:00', calls: 4, p95: 180 });
    expect(d[1]!.p95).toBeNull();
  });
  it('daily labels', () =>
    expect(trendData([{ at: '2026-10-18T00:00:00.000Z', count: 1, totalMs: '1', maxMs: 1, avgMs: 1, p95: { value: 1, basis: 'interpolated' } }], 'daily')[0]!.label).toBe('Oct 18'));
});
