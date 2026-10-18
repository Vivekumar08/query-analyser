import { describe, it, expect } from 'vitest';
import { safeNext } from './safe-next';

const ORIGIN = 'https://site.example';

describe('safeNext', () => {
  it.each([
    ['/\\evil.com', '/\\evil.com'],
    ['//evil.com', '//evil.com'],
    ['https://evil.com', 'https://evil.com'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
  ])('falls back on %s', (raw) => {
    expect(safeNext(raw, ORIGIN)).toBe('/');
  });

  // Dot-segment bypass: every one of these resolves SAME-origin, so an origin
  // comparison alone accepts them — but the resolved pathname is `//evil.com`,
  // and any later string re-parse of that pathname (a redirect Location, a
  // router.push) treats it as protocol-relative and lands on https://evil.com.
  it.each([
    '/.//evil.com',
    '/..//evil.com',
    '/a/..//evil.com',
    '/%2e//evil.com',
    '/%2e%2e//evil.com',
    '/./\\evil.com',
    '/.//evil.com?x=1',
  ])('falls back on the dot-segment bypass %s', (raw) => {
    expect(safeNext(raw, ORIGIN)).toBe('/');
  });

  it('never returns anything that re-parses to a foreign origin', () => {
    // The property the callers actually depend on, checked directly.
    for (const raw of ['/.//evil.com', '/%2e%2e//evil.com', '/./\\evil.com', '/\\evil.com', '//evil.com']) {
      expect(new URL(safeNext(raw, ORIGIN), ORIGIN).origin).toBe(ORIGIN);
    }
  });

  it('falls back on null', () => {
    expect(safeNext(null, ORIGIN)).toBe('/');
  });

  it('falls back on undefined', () => {
    expect(safeNext(undefined, ORIGIN)).toBe('/');
  });

  it('falls back on empty string', () => {
    expect(safeNext('', ORIGIN)).toBe('/');
  });

  it('preserves a bare same-origin path intact', () => {
    expect(safeNext('/dashboard', ORIGIN)).toBe('/dashboard');
  });

  it('preserves a same-origin path with query intact', () => {
    expect(safeNext('/dashboard?tab=queries&page=2', ORIGIN)).toBe('/dashboard?tab=queries&page=2');
  });

  it('preserves a nested same-origin path that merely contains dot segments', () => {
    expect(safeNext('/a/../dashboard?x=1', ORIGIN)).toBe('/dashboard?x=1');
  });

  it('returns the custom fallback when given one', () => {
    expect(safeNext('https://evil.com', ORIGIN, '/dashboard')).toBe('/dashboard');
    expect(safeNext(null, ORIGIN, '/dashboard')).toBe('/dashboard');
  });
});
