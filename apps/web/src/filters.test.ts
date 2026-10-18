import { describe, it, expect } from 'vitest';
import { parseFilters, filtersToSearch, filtersToApiQuery } from './filters';

const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('parseFilters', () => {
  it('defaults', () => expect(parseFilters({})).toEqual({
    range: { kind: 'preset', preset: '24h' }, sort: 'wasted', limit: 25 }));
  it('single model and op', () => {
    const f = parseFilters(new URLSearchParams('model=Order&op=find'));
    expect(f.model).toBe('Order');
    expect(f.op).toBe('find');
  });
  it('repeated model/op keep only the first (the API 400s on repeats)', () => {
    const f = parseFilters(new URLSearchParams('model=Order&model=User&op=find&op=update'));
    expect(f.model).toBe('Order');
    expect(f.op).toBe('find');
  });
  it('first non-empty value wins; empty values are dropped', () => {
    const f = parseFilters(new URLSearchParams('model=&model=User&op='));
    expect(f.model).toBe('User');
    expect(f.op).toBeUndefined();
  });
  it('a value over 200 chars is dropped', () => {
    const f = parseFilters(new URLSearchParams(`model=${'a'.repeat(201)}&op=${'b'.repeat(200)}`));
    expect(f.model).toBeUndefined();
    expect(f.op).toBe('b'.repeat(200));
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
    expect(q.getAll('op')).toEqual([]);
    expect(q.get('sort')).toBe('count');
    expect(q.get('limit')).toBe('25');
  });
});
