import { describe, it, expect } from 'vitest';
import { clearFiltersHref, emptyKind, listOutcome, loadSummary, toRowsView, toSummary } from './queries-view';
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

describe('SQL labels', () => {
  const base = (extra: object) => ({ ...row('a', '4000', 4), ...extra });
  it('labels a SQL row and a Mongo row from an older API', () => {
    const [sql, mongo] = toRowsView([
      base({ source: 'postgresql', orm: 'prisma', errors: 2, sampleRate: 0.1, sampled: true }),
      base({}),
    ] as never);
    expect(sql).toMatchObject({ source: 'postgresql', sourceLabel: 'PostgreSQL', ormLabel: 'Prisma', errors: 2, sampledLabel: 'estimated (sampled at 10%)' });
    expect(mongo).toMatchObject({ source: 'mongodb', sourceLabel: 'MongoDB', ormLabel: 'Mongoose / driver', errors: null, sampledLabel: null });
  });
  it('a SQL row with no errors keeps a real 0', () =>
    expect(toRowsView([base({ source: 'postgresql', errors: 0 })] as never)[0]!.errors).toBe(0));
  it('passes null SQL percentiles through', () =>
    expect(toRowsView([base({ source: 'postgresql', p95: null })] as never)[0]!.p95).toBeNull());
});

describe('emptyKind', () => {
  it('rows → none', () => expect(emptyKind({ rows: 3, filtered: true })).toBe('none'));
  it('no rows, no filters → no-data', () => expect(emptyKind({ rows: 0, filtered: false })).toBe('no-data'));
  it('no rows with filters → no-match', () => expect(emptyKind({ rows: 0, filtered: true })).toBe('no-match'));
});

describe('clearFiltersHref', () => {
  it('drops page', () =>
    expect(clearFiltersHref('/b', parseFilters(new URLSearchParams('range=7d&page=4')))).toBe('/b/queries?range=7d'));
  it('keeps the range, drops model/sort', () =>
    expect(clearFiltersHref('/b', parseFilters(new URLSearchParams('range=7d&model=A&sort=count')))).toBe('/b/queries?range=7d'));
  it('default range → bare path', () =>
    expect(clearFiltersHref('/b', parseFilters(new URLSearchParams('model=A')))).toBe('/b/queries'));
});

describe('clearFiltersHref (SQL)', () => {
  it('drops source and orm', () =>
    expect(clearFiltersHref('/b', parseFilters(new URLSearchParams('range=7d&source=postgresql&orm=prisma')))).toBe('/b/queries?range=7d'));
});

describe('listOutcome', () => {
  it('ok → ok', () => expect(listOutcome({ ok: true, data: {} })).toBe('ok'));
  it('400 → invalid-filters', () => expect(listOutcome({ ok: false, status: 400, error: 'x' })).toBe('invalid-filters'));
  it.each([401, 403, 404, 500, 503])('%i → error', (status) =>
    expect(listOutcome({ ok: false, status, error: 'x' })).toBe('error'));
});

describe('toSummary / loadSummary', () => {
  const good = { grain: 'hourly', from: 'a', to: 'b', thresholdMs: 100, droppedNew: 0, sources: [] };
  const ok = (data: unknown) => ({ ok: true, data }) as never;
  it('passes a well-formed summary through', () => expect(toSummary(ok(good))).toEqual(good));
  it.each([
    ['null body', null], ['empty object', {}], ['string body', 'oops'],
    ['sources not an array', { ...good, sources: {} }], ['droppedNew missing', { ...good, droppedNew: undefined }],
    ['droppedNew NaN', { ...good, droppedNew: NaN }], ['droppedNew a string', { ...good, droppedNew: '3' }],
  ])('returns null for a malformed 200: %s', (_n, body) => expect(toSummary(ok(body))).toBeNull());
  it('returns null for a failed result', () => expect(toSummary({ ok: false, status: 404, error: 'x' })).toBeNull());
  it('loadSummary hides the strip on a 404 and on a thrown fetch', async () => {
    expect(await loadSummary(async () => ({ ok: false, status: 404, error: 'x' }))).toBeNull();
    expect(await loadSummary(async () => { throw new Error('network'); })).toBeNull();
    expect(await loadSummary(async () => ok(good))).toEqual(good);
  });
});
