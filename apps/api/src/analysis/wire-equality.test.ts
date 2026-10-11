/**
 * Proves that the wire shapes in `@query-analyser/contract` are exactly what
 * this API's internal types become after serialisation.
 *
 * This check lives here, in `apps/api`, rather than in the contract package:
 * `RankRow` is owned by this package (`./routes.js`), and this package's own
 * `tsconfig` program already includes Fastify's `declare module`
 * augmentations and the generated Prisma client, so no `/// <reference />`
 * directives are needed to pull them in. The contract, by contrast, must stay
 * importable by a browser — it has no business reaching into `apps/api`'s
 * source tree or its gitignored, `prisma generate`-only output just to run a
 * type-level check.
 *
 * This is a compile-time check (via `tsc --noEmit`, which this package's
 * `typecheck` script runs — NOT `build`: `tsconfig.build.json` excludes
 * `src/**\/*.test.ts`, so a drifted type would compile and ship from the
 * Docker image's `build` step with this gate never firing). CI must run
 * `typecheck` for this check to mean anything. `vitest run` also type-checks
 * this file as a side effect of running it, which is why the runtime
 * assertion at the bottom exists: it gives the check a home in `vitest run`
 * output too, even though the real assertion is the type-level one above it.
 *
 * If someone changes `RankRow` here without changing `RankedQueryRow` in the
 * contract — or vice versa — this file stops compiling.
 */
import type { Serialized, RankedQueryRow } from '@query-analyser/contract';
import type { RankRow } from './routes.js';
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
