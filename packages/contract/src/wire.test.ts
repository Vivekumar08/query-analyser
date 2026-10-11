import { describe, it, expect } from 'vitest';
import { isPercentileBasis, parseNumericString } from './wire.js';
import type { NumericString, Serialized } from './wire.js';

// Mutually-assignable (structural equality). `Equal<A, B>` is `true` only when
// A and B accept exactly the same set of values. Same idiom as
// `sdk-types-equality.test.ts` and `apps/api/src/analysis/wire-equality.test.ts`.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type AssertTrue<T extends true> = T;

/**
 * Pins `Serialized<T>`'s distributive behaviour, which nothing else in this
 * package exercises: every field of `RankRow` (the only type
 * `api-wire-equality.test.ts`/`wire-equality.test.ts` checks `Serialized`
 * against) is a plain, non-union type. So a `Serialized<T>` rewritten into
 * the non-distributive form `[T] extends [bigint] ? ... : ...` still
 * satisfies that equality check and still compiles — `tsc` would not catch
 * the regression. These three assertions require the distributive form,
 * because `bigint | null` and `bigint | undefined` only serialise correctly
 * when the conditional distributes over the union.
 */
type _Nullable = AssertTrue<Equal<Serialized<{ a: bigint | null }>, { a: NumericString | null }>>;
type _Optional = AssertTrue<Equal<Serialized<{ a?: bigint }>, { a?: NumericString }>>;
type _NullableDate = AssertTrue<Equal<Serialized<{ a: Date | null }>, { a: string | null }>>;

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
