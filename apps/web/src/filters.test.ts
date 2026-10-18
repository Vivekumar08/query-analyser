import { describe, it, expect } from 'vitest';
import { parseFilters, filtersToSearch, filtersToApiQuery } from './filters';

const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('parseFilters', () => {
  it('defaults', () => expect(parseFilters({})).toEqual({
    range: { kind: 'preset', preset: '24h' }, models: [], ops: [], sort: 'wasted', limit: 25 }));
  it('repeatable model and op', () => {
    const f = parseFilters(new URLSearchParams('model=Order&model=User&op=find'));
    expect(f.models).toEqual(['Order', 'User']);
    expect(f.ops).toEqual(['find']);
  });
  it('unknown sort falls back', () => expect(parseFilters({ sort: 'drop' }).sort).toBe('wasted'));
  it('limit is a positive multiple of 25, capped at 500', () => {
    expect(parseFilters({ limit: '50' }).limit).toBe(50);
    expect(parseFilters({ limit: '-3' }).limit).toBe(25);
    expect(parseFilters({ limit: '9999' }).limit).toBe(500);
  });
});

describe('filtersToSearch', () => {
  it('round-trips and omits defaults', () => {
    const s = 'range=7d&model=Order&op=find&sort=p95&limit=50';
    expect(filtersToSearch(parseFilters(new URLSearchParams(s)))).toBe(s);
    expect(filtersToSearch(parseFilters({}))).toBe('');
  });
});

describe('filtersToApiQuery', () => {
  it('maps to the API params', () => {
    const q = new URLSearchParams(filtersToApiQuery(parseFilters(new URLSearchParams('range=1h&model=Order&sort=count')), NOW));
    expect(q.get('from')).toBe('2026-10-18T11:00:00.000Z');
    expect(q.get('to')).toBe('2026-10-18T12:00:00.000Z');
    expect(q.getAll('model')).toEqual(['Order']);
    expect(q.get('sort')).toBe('count');
    expect(q.get('limit')).toBe('25');
  });
});
