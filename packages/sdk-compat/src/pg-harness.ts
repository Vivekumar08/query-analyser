import { createRequire } from 'node:module';
import { ingestPayloadSchema } from '@query-analyser/contract';
import { capture } from './harness.js';

/**
 * Shared plumbing for the `pg` matrix: one row per `pg` 8 minor, each an npm
 * alias so every minor loads its own copy, plus `capture()` from harness.ts.
 * Each row is loaded with `require` (pg is CommonJS) and typed against the
 * `@types/pg` declarations, so the tests are written once.
 */

export { capture };

type Pg = typeof import('pg');

const require = createRequire(import.meta.url);

/** Loads `alias` and asserts its own package.json is the expected version. */
function load(alias: string, version: string): Pg {
  const actual = (require(`${alias}/package.json`) as { version: string }).version;
  if (actual !== version) throw new Error(`pg-harness: ${alias} is pg ${actual}, expected ${version}`);
  return require(alias) as Pg;
}

const ROWS: [minor: string, alias: string, version: string][] = [
  ['8.0', 'pg800', '8.0.3'],
  ['8.4', 'pg804', '8.4.2'],
  ['8.7', 'pg807', '8.7.3'],
  ['8.11', 'pg811', '8.11.6'],
  ['8.13', 'pg813', '8.13.3'],
  ['8.16', 'pg816', '8.16.3'],
  ['8.20', 'pg820', '8.20.0'],
  ['8.23', 'pg823', '8.23.1'],
];

export const PGS: { minor: string; alias: string; version: string; mod: Pg }[] = ROWS.map(([minor, alias, version]) => ({
  minor, alias, version, mod: load(alias, version),
}));

export type PgItem = {
  hash: string; signature: string; model: string; collection: string; operation: string;
  count: number; hist: number[]; histFine?: number[]; errors?: number;
  errorCodes?: { code: string; count: number }[]; database?: string; sql?: string; source: string;
  sample?: unknown;
};

/** Every sent item; each body must parse under the contract's ingest schema. */
export function itemsOf(bodies: string[]): PgItem[] {
  return bodies.flatMap((b) => {
    const parsed = JSON.parse(b) as { items: PgItem[] };
    ingestPayloadSchema.parse(parsed);
    return parsed.items;
  });
}

export const sqlOf = (i: PgItem): string => i.sql ?? i.signature;
export const sum = (xs: readonly number[] | undefined): number => (xs ?? []).reduce((a, b) => a + b, 0);
