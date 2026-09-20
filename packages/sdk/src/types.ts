/**
 * The SDK's own copy of the wire types shared with the (private, unpublished)
 * workspace contract package.
 *
 * The workspace contract package is never published. tsup's `noExternal`
 * inlines its runtime *values* into the built SDK, but it cannot inline a
 * `.d.ts` re-export of an unresolvable module specifier — a published
 * consumer's `tsc` would fail with TS2307 trying to resolve it.
 *
 * So the SDK carries its own structural copy of the four wire shapes it
 * needs, defined here, instead of importing types from that package. The
 * contract package remains the single source of truth for the wire format; a
 * compile-time equality test in the contract package asserts these
 * definitions and the contract's stay identical, so they cannot silently
 * drift apart.
 */

export type OpClass = 'eq' | 'in' | 'range' | 'regex' | 'exists' | 'ne' | 'other';

export interface FilterShapeItem {
  key: string;
  op: OpClass;
}

export interface SortKey {
  key: string;
  dir: 1 | -1;
}

export interface IngestItem {
  signature: string;
  hash: string;
  model: string;
  operation: string;
  filterShape: FilterShapeItem[];
  sortKeys: SortKey[];
  stages: string[];
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  lastTs: number;
  hist: number[];
  sample: unknown | null;
}

export interface IngestPayload {
  app: string;
  env: string;
  host: string;
  sdkVersion: string;
  bucket: string;
  thresholdMs: number;
  dropped: number;
  items: IngestItem[];
}
