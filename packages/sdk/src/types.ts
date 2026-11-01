/**
 * The SDK's own copy of the wire types shared with the (private, unpublished)
 * workspace contract package.
 *
 * The workspace contract package is never published. tsup's `noExternal`
 * inlines its runtime *values* into the built SDK, but it cannot inline a
 * `.d.ts` re-export of an unresolvable module specifier — a published
 * consumer's `tsc` would fail with TS2307 trying to resolve it.
 *
 * So the SDK carries its own structural copy of the wire shapes it
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

/** End-to-end encrypted sample envelope (ECIES, P-256 + AES-256-GCM), base64 fields. */
export interface EncryptedSample {
  v: 1;
  /** Ephemeral P-256 public key, raw uncompressed point, base64. */
  epk: string;
  iv: string;
  ct: string;
}

export interface ErrorCodeCount {
  code: string;
  count: number;
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
  /** Where the query was captured from. Absent on SDK 0.1/0.2 payloads, which read as `mongodb`. Open-ended: unknown values are accepted. */
  source?: string;
  /** The real collection name the command ran against (at most 255 characters). Absent on SDK 0.1/0.2 payloads. */
  collection?: string;
  /** SQL items only; absent on Mongo items and on SDK 0.1–0.3. The ORM that issued the statement (e.g. `prisma`). */
  orm?: string;
  /** SQL items only; absent on Mongo items and on SDK 0.1–0.3. The database name (a label, not part of the hash). */
  database?: string;
  /** SQL items only; absent on Mongo items and on SDK 0.1–0.3. The normalised SQL text, every literal replaced by `?`. */
  sql?: string;
  /** SQL items only; absent on Mongo items and on SDK 0.1–0.3. Count of failed statements. */
  errors?: number;
  /** SQL items only; absent on Mongo items and on SDK 0.1–0.3. Failed-statement counts by SQLSTATE (at most 8). */
  errorCodes?: ErrorCodeCount[];
  /** SQL items only; absent on Mongo items and on SDK 0.1–0.3. Fine latency histogram, FINE_HIST_SIZE buckets. */
  histFine?: number[];
  /** SQL items only; absent on Mongo items and on SDK 0.1–0.3. Fraction (0 < r <= 1) of fast, successful statements that were counted. */
  sampleRate?: number;
  /** Present only when the SDK was given a `sampleKey`; `null` when this item's sample was skipped. */
  encryptedSample?: EncryptedSample | null;
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
