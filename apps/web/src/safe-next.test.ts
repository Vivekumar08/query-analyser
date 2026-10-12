import { describe, it, expect } from 'vitest';
import { safeNext } from './safe-next.js';

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
    // The refresh route's retry guard reads `r` back out of this query
    // string, so it must survive exactly.
    expect(safeNext('/dashboard?r=1', ORIGIN)).toBe('/dashboard?r=1');
  });

  it('returns the custom fallback when given one', () => {
    expect(safeNext('https://evil.com', ORIGIN, '/dashboard')).toBe('/dashboard');
    expect(safeNext(null, ORIGIN, '/dashboard')).toBe('/dashboard');
  });
});
