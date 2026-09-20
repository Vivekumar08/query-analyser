/**
 * The published SDK cannot import types from this (private, unpublished)
 * package — see `packages/sdk/src/types.ts` for why. Instead it carries its
 * own structural copy of the four wire shapes it needs. This file is the
 * guard against that copy silently drifting from the contract's definitions:
 * it is a compile-time-only check (via `tsc --noEmit`, run by this package's
 * `build`/`typecheck` scripts) that the two sets of types are structurally
 * identical. If someone changes one without the other, `pnpm --filter
 * @query-analyser/contract build` fails here.
 */
import type { OpClass, FilterShapeItem, SortKey, IngestItem, IngestPayload } from './runtime.js';
import type {
  OpClass as SdkOpClass,
  FilterShapeItem as SdkFilterShapeItem,
  SortKey as SdkSortKey,
  IngestItem as SdkIngestItem,
  IngestPayload as SdkIngestPayload,
} from '../../sdk/src/types.js';
import { describe, it, expect } from 'vitest';

// Mutually-assignable (structural equality) check. `Equal<A, B>` resolves to
// `true` only when A and B accept exactly the same set of values.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type AssertTrue<T extends true> = T;

type _OpClass = AssertTrue<Equal<OpClass, SdkOpClass>>;
type _FilterShapeItem = AssertTrue<Equal<FilterShapeItem, SdkFilterShapeItem>>;
type _SortKey = AssertTrue<Equal<SortKey, SdkSortKey>>;
type _IngestItem = AssertTrue<Equal<IngestItem, SdkIngestItem>>;
type _IngestPayload = AssertTrue<Equal<IngestPayload, SdkIngestPayload>>;

describe('SDK wire-type copy stays identical to the contract', () => {
  it('compiles (the real assertion is the type-level check above)', () => {
    // If this file compiles under `tsc --noEmit`, every Equal<> above
    // resolved to `true`. This runtime assertion just gives the check a
    // home in `vitest run` output too.
    expect(true).toBe(true);
  });
});
