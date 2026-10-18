import type { PercentileResult, RankedQueryRow, Serialized } from '@query-analyser/contract';

/*
 * Wire shapes of the dashboard read endpoints, verified against
 * apps/api/src/{orgs,apps,analysis}/routes.ts. Dates are ISO strings and
 * BigInt columns are numeric strings (see `totalMs`).
 */

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

/** GET /v1/orgs → OrgSummary[] (a bare array). */
export interface OrgSummary { id: string; name: string; slug: string; plan: string; createdAt: string; role: Role }

/** GET /v1/orgs/:orgId/apps → AppSummary[] (a bare array). */
export interface AppSummary { id: string; name: string; env: string; createdAt: string }

/** GET /v1/apps/:id */
export interface AppDetail extends AppSummary { orgId: string; ingest: { lastSeenAt: string | null; keyCount: number } }

export interface SuggestionField { field: string; dir: 1 | -1 }

/**
 * The raw `Advice` row. `suggestion` is written by the nightly job
 * (analysis/jobs.ts upsert, from adviceFor in advice.ts): a non-empty ordered
 * list of `{field, dir: 1 | -1}` in index key order (equality, sort, range;
 * `_id` excluded).
 */
export interface Advice {
  id: string;
  signatureId: string;
  suggestion: SuggestionField[];
  rationale: string;
  status: 'OPEN' | 'APPLIED' | 'DISMISSED';
  updatedAt: string;
}

/**
 * GET /v1/apps/:id/queries/:sig. Always ALL-TIME: the route reads every rollup
 * of the signature and ignores `from`/`to`.
 * `avgMs` is 0 (not null) when count is 0; `p95`/`p99` are always present
 * (`floor` basis with value 0 when there is no data).
 */
export interface QueryDetail {
  hash: string; signature: string; model: string; operation: string;
  firstSeen: string; lastSeen: string; count: number; totalMs: string; maxMs: number;
  avgMs: number; p95: PercentileResult; p99: PercentileResult;
  hist: number[]; redactedSample: unknown | null; advice: Advice | null;
}

/** Same `avgMs`/`p95` guarantees as QueryDetail. */
export interface SeriesPoint { at: string; count: number; totalMs: string; maxMs: number; avgMs: number; p95: PercentileResult }

/** GET /v1/apps/:id/queries/:sig/series */
export interface SeriesResponse { grain: 'hourly' | 'daily'; from: string; to: string; points: SeriesPoint[] }

/** One row of the ranked list. The list route returns `avgMs` and `p95` per row, but NOT `hist` (toItem drops it). */
export type QueryRow = Omit<Serialized<RankedQueryRow>, 'hist'> & { avgMs: number; p95: PercentileResult };

/**
 * GET /v1/apps/:id/queries — an envelope, NOT a bare array. `sortExact` is
 * false only for `sort=p95` (re-ordered after the limit; `sortNote` explains).
 */
export interface QueryListResponse {
  grain: 'hourly' | 'daily';
  limit: number;
  offset: number;
  hasMore: boolean;
  sort: 'wasted' | 'count' | 'p95' | 'maxMs';
  sortExact: boolean;
  sortNote?: string;
  from: string;
  to: string;
  items: QueryRow[];
}
