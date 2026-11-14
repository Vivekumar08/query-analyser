/**
 * Zero-dependency runtime values shared by the SDK and the API.
 * This module must never import zod — the published SDK inlines it,
 * and the SDK ships with no runtime dependencies.
 */

export const HIST_BOUNDS = [100, 250, 500, 1000, 2500, 5000, 10000] as const;
export const HIST_SIZE = 8;

/** Upper bounds (ms) of the fine latency histogram used by SQL items; the last bucket is open-ended. */
export const FINE_HIST_BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
export const FINE_HIST_SIZE = 14;

export type OpClass = 'eq' | 'in' | 'range' | 'regex' | 'exists' | 'ne' | 'other';

export interface FilterShapeItem {
  key: string;
  op: OpClass;
}

export interface SortKey {
  key: string;
  dir: 1 | -1;
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

/** Response body of a successful ingest. */
export interface IngestResponse {
  accepted: number;
  droppedNew: number;
}

/** `YYYYMMDDHH` in UTC — the hour bucket a measurement belongs to. */
export function bucketOf(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    p(date.getUTCFullYear(), 4) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours())
  );
}

// End-to-end sample crypto (Web Crypto only, zero-dependency).
export * from './sample-crypto.js';
import type { EncryptedSample } from './sample-crypto.js';
