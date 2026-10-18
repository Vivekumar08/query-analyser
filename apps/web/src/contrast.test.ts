import { describe, it, expect } from 'vitest';
import { contrastRatio, compositeOver } from './contrast';
import { MIST } from './mist-tokens';

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('contrastRatio', () => {
  it('black on white is 21:1', () => expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 2));
  it('a colour on itself is 1:1', () => expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1));
  it('is symmetric', () => expect(contrastRatio('#1E2235', '#F7F8FC')).toBeCloseTo(contrastRatio('#F7F8FC', '#1E2235'), 6));
});

describe('compositeOver', () => {
  it('blends white at 90% over the Mist base', () => {
    const [r, g, b] = channels(compositeOver('#FFFFFF', 0.9, '#F7F8FC'));
    // 0.9*255 + 0.1*base
    expect(Math.abs(r! - Math.round(0.9 * 255 + 0.1 * 0xf7))).toBeLessThanOrEqual(1);
    expect(Math.abs(g! - Math.round(0.9 * 255 + 0.1 * 0xf8))).toBeLessThanOrEqual(1);
    expect(Math.abs(b! - Math.round(0.9 * 255 + 0.1 * 0xfc))).toBeLessThanOrEqual(1);
  });
});

describe('Mist tokens', () => {
  const textTokens = { ink: MIST.ink, muted: MIST.muted, caption: MIST.caption, accentText: MIST.accentText };
  const strongGlass = compositeOver('#FFFFFF', MIST.glassStrongAlpha, MIST.base);

  for (const [name, hex] of Object.entries(textTokens)) {
    it(`${name} passes AA (4.5:1) on the base and on strong glass`, () => {
      expect(contrastRatio(hex, MIST.base)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, strongGlass)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the chart periwinkle is not a text token', () => {
    expect(Object.values(textTokens)).not.toContain(MIST.accentChart);
  });
});
