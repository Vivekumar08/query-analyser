import { describe, it, expect } from 'vitest';
import { isPercentileBasis, parseNumericString } from './wire.js';

describe('isPercentileBasis', () => {
  it('accepts the two documented bases', () => {
    expect(isPercentileBasis('interpolated')).toBe(true);
    expect(isPercentileBasis('floor')).toBe(true);
  });

  it('rejects anything else, including near-misses', () => {
    // The UI renders `p95 ≈` for interpolated and `p95 ≥` for floor. A third
    // value arriving unnoticed would render as one of them and silently claim
    // precision the service did not promise.
    expect(isPercentileBasis('exact')).toBe(false);
    expect(isPercentileBasis('Floor')).toBe(false);
    expect(isPercentileBasis('')).toBe(false);
    expect(isPercentileBasis(undefined)).toBe(false);
    expect(isPercentileBasis(null)).toBe(false);
    expect(isPercentileBasis(0)).toBe(false);
  });
});

describe('parseNumericString', () => {
  it('converts a wire numeric string to a number', () => {
    expect(parseNumericString('0')).toBe(0);
    expect(parseNumericString('1234')).toBe(1234);
  });

  it('throws on a value that is not an integer string', () => {
    // totalMs arrives as a string because it is a BigInt behind the API's
    // serializer. Anything else means the contract and the API have drifted,
    // and failing loudly beats rendering NaN in a latency column.
    expect(() => parseNumericString('')).toThrow();
    expect(() => parseNumericString('abc')).toThrow();
    expect(() => parseNumericString('12.5')).toThrow();
  });

  it('throws rather than silently losing precision above Number.MAX_SAFE_INTEGER', () => {
    // A busy app's summed totalMs can exceed 2^53. Returning a quietly wrong
    // number here would understate the one figure the product exists to rank
    // on, so the caller is told instead.
    expect(() => parseNumericString('9007199254740993')).toThrow(/precision/i);
  });
});
