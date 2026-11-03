import type { EncryptedSample, PercentileResult, RankedQueryRow, Serialized, WrappedKey } from '@query-analyser/contract';

/*
 * Wire shapes of the dashboard read endpoints, verified against
 * apps/api/src/{orgs,apps,analysis}/routes.ts. Dates are ISO strings and
 * BigInt columns are numeric strings (see `totalMs`).
 */

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

/**
 * The org's plan limits, as GET /v1/orgs sends them (apps/api/src/plans.ts).
 * `dailyRetentionDays` is the effective value (it includes any grace period).
 */
export interface PlanLimits {
  ownedOrgs: number;
  apps: number;
  seats: number;
  invitableRoles: Role[];
  dailyRetentionDays: number;
}

/** GET /v1/orgs → OrgSummary[] (a bare array). */
/** `createdByMe`: the caller created this org (what the org limit counts, not ownership). */
export interface OrgSummary {
  id: string; name: string; slug: string; plan: string; createdAt: string; role: Role; createdByMe: boolean; limits: PlanLimits;
}

export const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];

export const ROLE_LABEL: Record<Role, string> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member', VIEWER: 'Viewer' };

/** OWNER or ADMIN: may create apps and manage the org. */
export function isAdminRole(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** One app a MEMBER/VIEWER can open, with their role on it. */
export interface MemberApp { id: string; name: string; role: Role }

/**
 * GET /v1/orgs/:orgId/members (ADMIN+) → Member[]. `id` is the membership id.
 * `allApps` is true for OWNER/ADMIN (org-wide, `apps` empty); otherwise `apps`
 * lists the apps they were given.
 */
export interface Member {
  id: string; role: Role; createdAt: string; user: { id: string; email: string; name: string | null };
  allApps: boolean; apps: MemberApp[];
}

/** GET /v1/orgs/:orgId/invites (ADMIN+) → PendingInvite[]. Never carries the token. `appId` is null for org-wide invites. */
export interface PendingInvite { id: string; email: string; role: Role; appId: string | null; expiresAt: string; createdAt: string }

/** One person who can open an app. OWNER/ADMIN have `allApps`; the rest have a row for this app, with its role. */
export interface AppPerson { userId: string; name: string | null; email: string; role: Role; allApps: boolean }

/** GET /v1/apps/:id/access (ADMIN+): who can open the app, its pending invites, and the org's seats. */
export interface AppAccessList {
  people: AppPerson[];
  invites: Omit<PendingInvite, 'createdAt' | 'appId'>[];
  seats: { used: number; max: number };
}

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
 * `avgMs` is 0 (not null) when count is 0. `p95`/`p99` are
 * `floor` basis with value 0 when a MongoDB signature has no data, and null
 * for SQL without a complete fine histogram.
 * `encryptedSample` is opaque ciphertext, decryptable only in the browser
 * with the team passphrase; null when the app has no key or none arrived yet.
 */
export interface QueryDetail {
  hash: string; signature: string; model: string; operation: string;
  firstSeen: string; lastSeen: string; count: number; totalMs: string; maxMs: number;
  avgMs: number; p95: PercentileResult | null; p99: PercentileResult | null;
  hist: number[]; redactedSample: unknown | null; encryptedSample: EncryptedSample | null; advice: Advice | null;
  /** Optional so an API that has not been redeployed still type-matches. */
  source?: string; collection?: string | null;
  /** SQL fields (absent from an API that has not been redeployed). `sqlText` is normalized and literal-free. */
  orm?: string | null; database?: string | null; sqlText?: string | null; lastErrorCode?: string | null;
  errors?: number; p50?: PercentileResult | null; histFine?: number[] | null;
  sampled?: boolean; sampleRate?: number | null; thresholdMs?: number | null;
}

/** Same `avgMs`/`p95` guarantees as QueryDetail (`p95` is null for SQL without a complete fine histogram). */
export interface SeriesPoint { at: string; count: number; totalMs: string; maxMs: number; avgMs: number; p95: PercentileResult | null; errors?: number; p50?: PercentileResult | null; p99?: PercentileResult | null }

/** GET /v1/apps/:id/queries/:sig/series */
export interface SeriesResponse { grain: 'hourly' | 'daily'; from: string; to: string; points: SeriesPoint[] }

/**
 * One row of the ranked list. The route sends the RankedQueryRow fields and no
 * histograms. The SQL fields are optional so a web build still type-checks
 * against an API that has not been redeployed (those rows are MongoDB).
 * SQL percentiles are null unless the window has a complete fine histogram;
 * `sampled`/`sampleRate` drive the "estimated" label.
 */
export type QueryRow = Omit<Serialized<RankedQueryRow>, 'hist' | 'histFine' | 'minSampleRate' | 'source' | 'orm' | 'database' | 'errors' | 'avgMs' | 'p50' | 'p95' | 'p99' | 'sampled' | 'sampleRate'> & {
  avgMs: number; p95: PercentileResult | null;
  source?: string; orm?: string | null; errors?: number; sampled?: boolean; sampleRate?: number | null;
  p50?: PercentileResult | null; p99?: PercentileResult | null;
};

/**
 * GET /v1/apps/:id/queries — an envelope, NOT a bare array. `sortExact` is
 * false only for `sort=p95` (re-ordered after the limit; `sortNote` explains).
 */
export interface QueryListResponse {
  grain: 'hourly' | 'daily';
  limit: number;
  offset: number;
  hasMore: boolean;
  sort: 'wasted' | 'count' | 'p95' | 'maxMs' | 'errors';
  sortExact: boolean;
  sortNote?: string;
  from: string;
  to: string;
  items: QueryRow[];
}

/**
 * One source's figures in GET /v1/apps/:id/summary. `counts` says what `count`
 * counts: MongoDB records only slow queries, SQL sources every statement, so
 * sources are shown side by side and never added together. `totalMs` is a BigInt
 * on the API, hence a string here.
 */
export interface SourceSummary {
  source: string;
  counts: 'all-statements' | 'slow-only';
  count: number;
  totalMs: string;
  avgMs: number;
  maxMs: number;
  p50: PercentileResult | null;
  p95: PercentileResult | null;
  p99: PercentileResult | null;
  slowCount: number;
  errors: number;
  sampled: boolean;
  sampleRate: number | null;
}

/** GET /v1/apps/:id/summary. `droppedNew` sums dropped shape records per batch (repeats add), not distinct shapes. */
export interface SummaryResponse {
  grain: 'hourly' | 'daily';
  from: string;
  to: string;
  thresholdMs: number | null;
  droppedNew: number;
  sources: SourceSummary[];
}
