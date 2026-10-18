import { describe, it, expect } from 'vitest';
import { parseFilters, filtersToSearch, filtersToApiQuery, optionsApiQuery, MAX_LIMIT } from './filters';

const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('parseFilters', () => {
  it('defaults', () => expect(parseFilters({})).toEqual({
    range: { kind: 'preset', preset: '24h' }, sort: 'wasted', page: 1 }));
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
  it('page is an integer >= 1, else 1', () => {
    expect(parseFilters({ page: '3' }).page).toBe(3);
    for (const bad of ['0', '-2', 'x', '1.5', '']) expect(parseFilters({ page: bad }).page).toBe(1);
    expect(parseFilters({}).page).toBe(1);
  });
  it('ignores a legacy limit param', () => expect('limit' in parseFilters({ limit: '50' })).toBe(false));
});

describe('filtersToSearch', () => {
  it('round-trips and omits defaults', () => {
    const s = 'range=7d&model=Order&op=find&sort=p95&page=3';
    expect(filtersToSearch(parseFilters(new URLSearchParams(s)))).toBe(s);
    expect(filtersToSearch(parseFilters({}))).toBe('');
  });
  it('omits page=1', () => {
    expect(filtersToSearch(parseFilters({ page: '1' }))).toBe('');
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

describe('paging in the API query', () => {
  it('sends limit 25 and offset (page-1)*25', () => {
    const q = new URLSearchParams(filtersToApiQuery(parseFilters({ page: '3' }), NOW));
    expect(q.get('limit')).toBe('25');
    expect(q.get('offset')).toBe('50');
    expect(new URLSearchParams(filtersToApiQuery(parseFilters({}), NOW)).get('offset')).toBe('0');
  });
  it('dropdown options call asks for limit 200, unfiltered, no offset', () => {
    expect(MAX_LIMIT).toBe(200);
    const q = new URLSearchParams(optionsApiQuery(parseFilters({ range: '7d', model: 'A', page: '4' }).range, NOW));
    expect(q.get('limit')).toBe('200');
    expect(q.get('offset')).toBeNull();
    expect(q.get('model')).toBeNull();
  });
});
