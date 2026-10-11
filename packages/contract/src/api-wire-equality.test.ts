/**
 * Proves that the wire shapes in `wire.ts` are exactly what the API's internal
 * types become after serialisation.
 *
 * This is a compile-time check (via `tsc --noEmit`, which this package's
 * `typecheck` and `build` scripts run). If someone changes `RankRow` in the API
 * without changing `RankedQueryRow` here — or vice versa — this file stops
 * compiling. The runtime assertion at the bottom only gives the check a home
 * in `vitest run` output too.
 *
 * It is the whole reason the wire shapes live in this package rather than being
 * hand-copied into the UI: `RankRow.totalMs` is a `bigint`, and the UI receives
 * a string. A UI typed against the internal shape would compile and be wrong.
 */
/// <reference path="../../../apps/api/src/app.ts" />
/// <reference path="../../../apps/api/src/plugins/auth.ts" />
/// <reference path="../../../apps/api/src/plugins/prisma.ts" />
import type { Serialized, RankedQueryRow } from './wire.js';
import type { RankRow } from '../../../apps/api/src/analysis/routes.js';
import { describe, it, expect } from 'vitest';

// Mutually-assignable (structural equality). `Equal<A, B>` is `true` only when
// A and B accept exactly the same set of values.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type AssertTrue<T extends true> = T;

type _RankedRow = AssertTrue<Equal<Serialized<RankRow>, RankedQueryRow>>;

describe('wire shapes are the serialisation of the API internal shapes', () => {
  it('compiles (the real assertion is the type-level check above)', () => {
    expect(true).toBe(true);
  });
});
