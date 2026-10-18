import { describe, it, expect } from 'vitest';
import { clearFiltersHref, emptyKind, listOutcome, toRowsView } from './queries-view';
import { parseFilters } from './filters';

const row = (hash: string, totalMs: string, count: number) => ({
  hash, signature: `{ a: eq }`, model: 'Order', operation: 'find', count, totalMs, maxMs: 900,
  avgMs: count ? Number(totalMs) / count : 0, p95: { value: 900, basis: 'floor' as const },
});

describe('toRowsView', () => {
  it('converts totalMs before computing share; worst row has share 1', () => {
    const v = toRowsView([row('a', '4000', 4), row('b', '1000', 2)] as never);
    expect(v[0]).toMatchObject({ title: 'Order.find', wasted: '4s', avg: '1s', wastedShare: 1 });
    expect(v[1]!.wastedShare).toBe(0.25);
  });
  it('all-zero totals give share 0, not NaN', () =>
    expect(toRowsView([row('a', '0', 0)] as never)[0]!.wastedShare).toBe(0));
  it('passes p95 through untouched', () =>
    expect(toRowsView([row('a', '4000', 4)] as never)[0]!.p95).toEqual({ value: 900, basis: 'floor' }));
});

describe('emptyKind', () => {
  it('rows → none', () => expect(emptyKind({ rows: 3, filtered: true })).toBe('none'));
  it('no rows, no filters → no-data', () => expect(emptyKind({ rows: 0, filtered: false })).toBe('no-data'));
  it('no rows with filters → no-match', () => expect(emptyKind({ rows: 0, filtered: true })).toBe('no-match'));
});

describe('clearFiltersHref', () => {
  it('keeps the range, drops model/sort', () =>
    expect(clearFiltersHref('/b', parseFilters(new URLSearchParams('range=7d&model=A&sort=count')))).toBe('/b/queries?range=7d'));
  it('default range → bare path', () =>
    expect(clearFiltersHref('/b', parseFilters(new URLSearchParams('model=A')))).toBe('/b/queries'));
});

describe('listOutcome', () => {
  it('ok → ok', () => expect(listOutcome({ ok: true, data: {} })).toBe('ok'));
  it('400 → invalid-filters', () => expect(listOutcome({ ok: false, status: 400, error: 'x' })).toBe('invalid-filters'));
  it.each([401, 403, 404, 500, 503])('%i → error', (status) =>
    expect(listOutcome({ ok: false, status, error: 'x' })).toBe('error'));
});
