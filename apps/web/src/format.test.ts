import { describe, it, expect } from 'vitest';
import { formatMs, toMs, formatAvg, formatCount } from './format';

describe('toMs', () => {
  it('converts a numeric string', () => expect(toMs('1500')).toBe(1500));
  it('passes numbers through', () => expect(toMs(42)).toBe(42));
  it('rejects garbage', () => expect(() => toMs('12ms')).toThrow());
});

describe('formatMs', () => {
  it('zero', () => expect(formatMs(0)).toBe('0ms'));
  it('sub-second', () => expect(formatMs(340)).toBe('340ms'));
  it('rounds sub-second to whole ms', () => expect(formatMs(340.6)).toBe('341ms'));
  it('seconds with one decimal', () => expect(formatMs(1234)).toBe('1.2s'));
  it('minutes and seconds', () => expect(formatMs(124_000)).toBe('2m 4s'));
  it('hours and minutes', () => expect(formatMs(3_780_000)).toBe('1h 3m'));
  it('accepts the API numeric string', () => expect(formatMs('1500')).toBe('1.5s'));
  it('huge values above 2^53 still format', () =>
    expect(formatMs('90071992547409930')).toMatch(/^\d[\d,]*h \d+m$/));
});

describe('formatAvg', () => {
  it('converts before dividing', () => expect(formatAvg('3000', 4)).toBe('750ms'));
  it('zero count shows an em dash', () => expect(formatAvg('0', 0)).toBe('—'));
  it('converts before dividing, so garbage throws instead of rendering 0ms', () =>
    expect(() => formatAvg('12ms', 2)).toThrow());
  it('huge totals average without throwing', () =>
    expect(formatAvg('90071992547409930', 2)).toMatch(/h \d+m$/));
});

describe('formatCount', () => {
  it('groups thousands', () => expect(formatCount(12345)).toBe('12,345'));
});
