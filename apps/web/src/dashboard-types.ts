import type { EncryptedSample, PercentileResult, RankedQueryRow, Serialized, WrappedKey } from '@query-analyser/contract';

/*
 * Wire shapes of the dashboard read endpoints, verified against
 * apps/api/src/{orgs,apps,analysis}/routes.ts. Dates are ISO strings and
 * BigInt columns are numeric strings (see `totalMs`).
 */

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

/** GET /v1/orgs → OrgSummary[] (a bare array). */
export interface OrgSummary { id: string; name: string; slug: string; plan: string; createdAt: string; role: Role }

export const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];

export const ROLE_LABEL: Record<Role, string> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member', VIEWER: 'Viewer' };

/** OWNER or ADMIN: may create apps and manage the org. */
export function isAdminRole(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** GET /v1/orgs/:orgId/members (ADMIN+) → Member[]. `id` is the membership id. */
export interface Member { id: string; role: Role; createdAt: string; user: { id: string; email: string; name: string | null } }

/** GET /v1/orgs/:orgId/invites (ADMIN+) → PendingInvite[]. Never carries the token. */
export interface PendingInvite { id: string; email: string; role: Role; expiresAt: string; createdAt: string }

/** GET /v1/orgs/:orgId/apps → AppSummary[] (a bare array). */
export interface AppSummary { id: string; name: string; env: string; createdAt: string }

/**
 * GET /v1/apps/:id/sample-key (VIEWER+). `wrapped` is the passphrase-wrapped
 * private key, unusable without the passphrase, which never leaves the browser.
 */
export interface SampleKeyStatus { enabled: boolean; publicKey?: string; wrapped?: WrappedKey }

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
 * `encryptedSample` is opaque ciphertext, decryptable only in the browser
 * with the team passphrase; null when the app has no key or none arrived yet.
 */
export interface QueryDetail {
  hash: string; signature: string; model: string; operation: string;
  firstSeen: string; lastSeen: string; count: number; totalMs: string; maxMs: number;
  avgMs: number; p95: PercentileResult; p99: PercentileResult;
  hist: number[]; redactedSample: unknown | null; encryptedSample: EncryptedSample | null; advice: Advice | null;
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
