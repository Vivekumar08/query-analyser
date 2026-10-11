/**
 * The shapes the read endpoints' JSON actually carries.
 *
 * These are deliberately NOT the API's internal types. `apps/api` holds
 * `totalMs` as a `bigint` and `firstSeen`/`lastSeen` as `Date`s; the reply
 * serializer in `apps/api/src/app.ts` turns the former into a string and
 * `JSON.stringify` turns the latter into ISO strings. A UI typed against the
 * internal shapes would compile and be wrong at runtime everywhere, which is
 * worse than a hand-copied interface. `api-wire-equality.test.ts` proves these
 * shapes are exactly what serialisation produces.
 */

/** A base-10 integer carried as a string because it exceeds JSON's safe range. */
export type NumericString = string;

/**
 * `interpolated` — the rank fell in a bounded histogram bucket and the value is
 * a linear estimate inside it.
 * `floor` — the rank fell in the unbounded top bucket (or there is no data), so
 * the value is the largest observation recorded and the real percentile is at
 * least this.
 */
export type PercentileBasis = 'interpolated' | 'floor';

export interface PercentileResult {
  /** Milliseconds. */
  value: number;
  basis: PercentileBasis;
}

/** One row of the ranked query list. */
export interface RankedQueryRow {
  hash: string;
  signature: string;
  model: string;
  operation: string;
  count: number;
  /** Summed milliseconds. A string: see NumericString. */
  totalMs: NumericString;
  maxMs: number;
  hist: number[];
}

/**
 * What `JSON.stringify` plus the API's reply serializer do to a type.
 *
 * `bigint` becomes a string (the serializer), `Date` becomes a string
 * (JSON.stringify calls toJSON), and everything else recurses. This is how the
 * equality test states "the wire shape is the serialisation of the internal
 * shape" as a type rather than as a comment.
 */
export type Serialized<T> = T extends bigint
  ? NumericString
  : T extends Date
    ? string
    : T extends (infer U)[]
      ? Serialized<U>[]
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;

const BASES: readonly PercentileBasis[] = ['interpolated', 'floor'];

export const isPercentileBasis = (v: unknown): v is PercentileBasis =>
  typeof v === 'string' && (BASES as readonly string[]).includes(v);

/**
 * Converts a wire numeric string to a number, refusing anything it cannot
 * represent exactly.
 *
 * The UI does arithmetic on `totalMs` (shares of total time, averages), so the
 * conversion happens once, here, rather than at each call site.
 */
export function parseNumericString(v: NumericString): number {
  if (!/^-?\d+$/.test(v)) {
    throw new Error(`expected a base-10 integer string, got "${v}"`);
  }
  const asBig = BigInt(v);
  if (asBig > BigInt(Number.MAX_SAFE_INTEGER) || asBig < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new Error(`"${v}" exceeds Number.MAX_SAFE_INTEGER; converting would lose precision`);
  }
  return Number(asBig);
}
