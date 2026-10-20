import { describe, it, expect } from 'vitest';
import { parseRange, presetAllowed, rangeToWindow, rangeToParams } from './range';

const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('parseRange', () => {
  it('defaults to 24h', () => expect(parseRange({})).toEqual({ kind: 'preset', preset: '24h' }));
  it('reads a preset', () => expect(parseRange({ range: '7d' })).toEqual({ kind: 'preset', preset: '7d' }));
  it('unknown preset falls back to 24h', () => expect(parseRange({ range: '5y' })).toEqual({ kind: 'preset', preset: '24h' }));
  it('reads a custom range', () =>
    expect(parseRange({ range: 'custom', from: '2026-10-01', to: '2026-10-05' })).toEqual({
      kind: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T23:59:59.999Z',
    }));
  it('inverted custom range falls back to 24h', () =>
    expect(parseRange({ range: 'custom', from: '2026-10-05', to: '2026-10-01' })).toEqual({ kind: 'preset', preset: '24h' }));
  it('garbage custom dates fall back to 24h', () =>
    expect(parseRange({ range: 'custom', from: 'yesterday', to: 'x' })).toEqual({ kind: 'preset', preset: '24h' }));
  it('accepts URLSearchParams', () => expect(parseRange(new URLSearchParams('range=1h'))).toEqual({ kind: 'preset', preset: '1h' }));
  it('inherited object keys are not presets', () => {
    for (const range of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(parseRange({ range })).toEqual({ kind: 'preset', preset: '24h' });
    }
  });
  it('calendar-invalid custom date falls back to 24h', () =>
    expect(parseRange({ range: 'custom', from: '2026-02-31', to: '2026-03-05' })).toEqual({ kind: 'preset', preset: '24h' }));
  it('same-day custom range covers the whole day', () =>
    expect(parseRange({ range: 'custom', from: '2026-10-05', to: '2026-10-05' })).toEqual({
      kind: 'custom', from: '2026-10-05T00:00:00.000Z', to: '2026-10-05T23:59:59.999Z',
    }));
});

describe('parseRange with the plan\'s retention', () => {
  it('a preset longer than retention falls back to 24h (Review Focus)', () =>
    expect(parseRange({ range: '30d' }, 7)).toEqual({ kind: 'preset', preset: '24h' }));
  it('a preset within retention is kept', () => expect(parseRange({ range: '7d' }, 7)).toEqual({ kind: 'preset', preset: '7d' }));
  it('no retention given keeps every preset', () => expect(parseRange({ range: '30d' })).toEqual({ kind: 'preset', preset: '30d' }));
  it('a custom range starting before retention is clamped to the first kept day', () =>
    // 7 days before 2026-10-18T12:00Z is 2026-10-11.
    expect(parseRange({ range: 'custom', from: '2026-09-01', to: '2026-10-15' }, 7, NOW)).toEqual({
      kind: 'custom', from: '2026-10-11T00:00:00.000Z', to: '2026-10-15T23:59:59.999Z',
    }));
  it('a custom range inside retention is kept', () =>
    expect(parseRange({ range: 'custom', from: '2026-10-12', to: '2026-10-15' }, 7, NOW)).toEqual({
      kind: 'custom', from: '2026-10-12T00:00:00.000Z', to: '2026-10-15T23:59:59.999Z',
    }));
  it('a custom range wholly before retention falls back to 24h', () =>
    expect(parseRange({ range: 'custom', from: '2026-09-01', to: '2026-09-05' }, 7, NOW)).toEqual({ kind: 'preset', preset: '24h' }));
});

describe('presetAllowed', () => {
  it('allows presets up to the retention and refuses longer ones', () => {
    expect(presetAllowed('1h', 7)).toBe(true);
    expect(presetAllowed('24h', 7)).toBe(true);
    expect(presetAllowed('7d', 7)).toBe(true);
    expect(presetAllowed('30d', 7)).toBe(false);
    expect(presetAllowed('30d', 30)).toBe(true);
  });
});

describe('rangeToWindow', () => {
  it('1h', () => expect(rangeToWindow({ kind: 'preset', preset: '1h' }, NOW)).toEqual({
    from: '2026-10-18T11:00:00.000Z', to: '2026-10-18T12:00:00.000Z' }));
  it('30d', () => expect(rangeToWindow({ kind: 'preset', preset: '30d' }, NOW).from).toBe('2026-09-18T12:00:00.000Z'));
  it('custom passes through', () => expect(rangeToWindow({ kind: 'custom', from: 'a', to: 'b' }, NOW)).toEqual({ from: 'a', to: 'b' }));
});

describe('rangeToParams', () => {
  it('omits the default', () => expect(rangeToParams({ kind: 'preset', preset: '24h' })).toEqual({}));
  it('custom keeps dates as YYYY-MM-DD', () =>
    expect(rangeToParams({ kind: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T23:59:59.999Z' }))
      .toEqual({ range: 'custom', from: '2026-10-01', to: '2026-10-05' }));
});
