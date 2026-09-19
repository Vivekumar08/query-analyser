# query-analyser — Design

Date: 2026-09-20
Status: Approved for planning

## 1. Purpose

A hosted service that tells Node + MongoDB teams which of their queries are slow,
which are getting slower, and which index would fix them — after a one-line install.

The seed is the slow-query analyzer already running in KISNA
(`kisna-web-backend/api/db/slowQueryPlugin.db.js` and `api/analytics/analytics.js`):
mongoose hooks time every query, queries slower than a threshold are collapsed by
*signature* (query shape, not values) into an in-memory map, and a background timer
flushes aggregates to Redis hourly buckets. That design is sound and carries over.
What changes is the destination (a multi-tenant cloud instead of the app's own Redis),
and what the aggregate carries (enough to compute percentiles and index advice).

Non-goals for v1: any database other than MongoDB, any driver other than mongoose,
`explain()` capture, AI-written explanations, billing, and alert delivery by email or
Slack. Each is a later increment, and none of them changes the shapes below.

## 2. Product shape

Three audiences, one system:

- **The developer installing the SDK.** Adds one line, sets one env var, sees data in
  under a minute. Never has to think about the service again.
- **The customer's team.** Signs in, picks an app, sees ranked slow queries, trends,
  regressions, and suggested indexes. Invites teammates with roles.
- **The vendor (you).** Sees every organization, ingest health, quota use, and the
  worst offenders across the whole platform.

## 3. Architecture

A pnpm + turborepo monorepo at `Vivek Kumar/Projects/query-analyser`:

```
packages/contract   zod schemas + TS types for the ingest payload (shared by SDK and API)
packages/sdk        @vivekumar08/query-analyser — published to public npm
apps/api            Fastify + Prisma + PostgreSQL, deployed as a Docker image
apps/web            Next.js 16 App Router — marketing home, customer dashboard, admin dashboard
```

Data flows one way:

```
mongoose hooks → in-memory aggregation (SDK) → HTTPS batch every 10s
  → POST /v1/ingest (Fastify) → bulk upsert into Postgres rollups
  → read APIs → Next.js dashboards
```

`packages/contract` exists so the SDK and the API cannot drift. The ingest payload is
defined once as a zod schema; the SDK type-checks what it sends against it and the API
validates what it receives with it.

The API is a long-lived Node process rather than serverless functions because ingest is
a high-rate, small-payload write path that benefits from connection reuse and in-process
batching, and because the rollup compaction and regression detection jobs are cron-like
work that wants a stable host.

## 4. The SDK

### Setup

```js
require('@vivekumar08/query-analyser').init({
  apiKey: process.env.QA_KEY,   // required
  app: 'kisna-web',             // required — names the app in the dashboard
});
```

Optional: `thresholdMs` (default 100), `flushIntervalMs` (default 10000),
`endpoint` (default the hosted ingest URL), `env` (default `NODE_ENV`),
`enabled` (default true), `onError` (default: write one line to stderr).

`mongoose` is a peer dependency, resolved from the host application so there is exactly
one mongoose instance. `init()` does two things: registers a global plugin via
`mongoose.plugin()` so every schema compiled from then on is instrumented, **and** walks
`mongoose.models` installing the same hooks on schemas that were already compiled. The
second half matters — a global plugin alone silently misses every model that was
imported before `init()` ran, which makes setup order-dependent and makes the one-line
promise false. Hooks are installed at most once per schema, tracked by a symbol on the
schema object.

### Hot path

Unchanged in spirit from KISNA. A `pre` hook on `/^find/`, `/^update/`, `/^delete/`,
`countDocuments`, `distinct` and `aggregate` stamps a start time; the matching `post`
hook measures the elapsed milliseconds. Below the threshold, nothing happens. Above it,
the query's shape is reduced to a signature and folded into an in-memory `Map`. No I/O
occurs on the query path, and the whole hook body is wrapped so that a failure inside
the SDK can never surface as a failure of the customer's query.

### Signature

A signature identifies a query *shape*. Two executions of the same code path with
different parameter values produce the same signature; that is what makes the data
small enough to aggregate and useful enough to act on.

```
<model>.<operation>(<filter keys with operator classes>)[<sort keys>]
```

Concretely, the aggregate entry carries:

```ts
{
  signature: string,          // stable hash input, also human-readable
  model: string,              // 'Order'
  operation: string,          // 'find' | 'findOne' | 'updateMany' | 'aggregate' | ...
  filterShape: Array<{ key: string, op: 'eq'|'in'|'range'|'regex'|'exists'|'ne'|'other' }>,
  sortKeys: Array<{ key: string, dir: 1 | -1 }>,
  stages: string[],           // aggregate only: ['$match','$lookup','$group']
  count: number,
  totalMs: number,
  maxMs: number,
  lastMs: number,
  lastTs: number,
  hist: number[],             // 8 counters
  sample: object | null,      // redacted, see below
}
```

Two deliberate additions over the KISNA version:

**Operator classes on filter keys.** KISNA records `Object.keys(filter).sort()`. That is
enough to group, but not enough to advise. The Equality–Sort–Range rule for compound
index order needs to know *how* each field is queried, so the SDK classifies each key by
inspecting its value: a plain value or `$eq` is `eq`, `$in`/`$all` is `in`, `$gt`/`$gte`/
`$lt`/`$lte` is `range`, `$regex` is `regex`, `$exists` is `exists`, `$ne`/`$nin` is `ne`,
anything else is `other`. Nested paths are flattened with dots; `$and`/`$or` branches are
flattened into the same list, since for index purposes what matters is the set of fields
touched. Array index positions are normalised to `$[]` so `items.0.sku` and `items.3.sku`
share a signature.

**A latency histogram.** Eight counters over the fixed boundaries
`[100, 250, 500, 1000, 2500, 5000, 10000, ∞)` milliseconds. `count`, `totalMs` and
`maxMs` can produce an average and a worst case but cannot produce a percentile — and
average latency hides exactly the tail that people install this tool to find. Eight
integers per signature per flush is a rounding error on payload size and makes p95 and
p99 computable server-side, across any time range, by summing histograms.

### Redaction

Values never leave the customer's process. The sample kept for a signature is the shape
with every leaf replaced by its type name:

```js
{ userId: '<ObjectId>', status: '<string>', createdAt: { $gte: '<Date>' } }
```

Types recognised: `ObjectId`, `string`, `number`, `boolean`, `Date`, `RegExp`, `null`,
`array[<type>]`, `object`. There is no option in v1 to send real values. This is a
product decision, not only a privacy one: it is the sentence that gets the SDK approved
by the customer's security reviewer, and an option to disable it would immediately
become a question they have to ask.

Redaction is applied to filters, update documents, and aggregate pipeline stages alike.
The redaction function is the single most security-relevant unit in the codebase and is
tested against a fixture set of deeply nested, mixed-type queries.

### Buffering and flush

One `Map` keyed by signature hash. A cap (`maxSignatures`, default 5000) guards against
signature explosion from, for example, a dynamically built filter; on reaching the cap
the SDK flushes early, and if still full, drops new signatures and increments a
`dropped` counter that is reported in the next batch so the dashboard can warn about it.

Every `flushIntervalMs` the buffer is swapped for a fresh `Map` and the old one is POSTed
as one batch. The timer is `unref()`'d so it never keeps a process alive. `beforeExit`
and `SIGTERM` trigger a final drain with a short timeout, so a scaling-down pod does not
lose its last window.

On a failed flush the batch is folded back into the buffer and retried on the next tick,
bounded by the same cap, with exponential backoff up to a ceiling. A 401 disables the
SDK for the process lifetime and logs once — a wrong key should not become a retry storm.
A 429 backs off for the duration the server asks for.

### Payload

```json
{
  "app": "kisna-web",
  "env": "production",
  "host": "web-7d9f-abc",
  "sdkVersion": "1.0.0",
  "bucket": "2026092014",
  "thresholdMs": 100,
  "dropped": 0,
  "items": [ /* aggregate entries as above */ ]
}
```

`bucket` is `YYYYMMDDHH` in UTC, computed by the SDK at flush time — the same hour-
resolution bucketing KISNA uses. Sending it rather than deriving it server-side keeps
the attribution correct when a batch is delayed by a retry.

Transport is `fetch` with `Content-Type: application/json`, gzip-encoded when the body
exceeds 1 KB, and `Authorization: Bearer <apiKey>`.

## 5. The API

Fastify, chosen for fast JSON serialisation and built-in schema validation on a write
path that will see far more requests than the dashboard does. Deployed as a Docker image,
so it can run on Railway, Render, Fly, a VM, or Vercel Services without change.

### Ingest

`POST /v1/ingest`, authenticated by the app's ingest key.

The key is looked up by SHA-256 hash, with the result cached in-process for 60 seconds so
the hot path does not hit Postgres for auth on every batch. A revoked or unknown key
returns 401. Rate limiting is per app via `@fastify/rate-limit`.

Writing a batch is two statements:

1. Upsert every `QuerySignature` in the batch by `(appId, hash)`, returning ids, and
   refreshing `lastSeen` and the redacted sample.
2. Upsert the rollup rows:

```sql
INSERT INTO "QueryRollup" ("signatureId","bucketHour","count","totalMs","maxMs","hist")
SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::int[], $4::bigint[], $5::int[], $6::int[][])
ON CONFLICT ("signatureId","bucketHour") DO UPDATE SET
  "count"   = "QueryRollup"."count"   + EXCLUDED."count",
  "totalMs" = "QueryRollup"."totalMs" + EXCLUDED."totalMs",
  "maxMs"   = GREATEST("QueryRollup"."maxMs", EXCLUDED."maxMs"),
  "hist"    = (SELECT array_agg(a + b) FROM unnest("QueryRollup"."hist", EXCLUDED."hist") AS t(a,b));
```

Prisma has no bulk upsert, so this runs through `$executeRaw`. The accumulate-and-take-
greatest semantics deliberately mirror KISNA's `ZINCRBY` / `HINCRBYFLOAT` / `ZADD GT`, so
concurrent batches from many app instances combine correctly without coordination.

At-least-once delivery means a retried batch can double-count. v1 accepts this: the
window is one flush interval, the data is statistical, and the alternative (a batch id
and a dedup table on the hot path) costs more than the error it prevents. The SDK does
not retry a batch the server has acknowledged, so duplication requires a response to be
lost in flight.

Quotas are enforced per organization as a cap on distinct signatures per app and a
requests-per-minute limit. Exceeding either returns 429 with a reason the SDK logs once
and the dashboard shows.

### Auth and RBAC

Self-hosted, no third-party identity provider.

Passwords are hashed with argon2id. A successful login issues a 15-minute JWT access
token and a refresh token stored as an httpOnly, Secure, SameSite=Lax cookie. Refresh
tokens rotate on every use and are stored hashed with a family id, so replay of a
consumed token invalidates the whole family — the standard detection for a stolen
refresh token.

Tenancy is `User → Membership → Organization`, with roles:

| Role | Can |
|---|---|
| OWNER | everything, including deleting the org and transferring ownership |
| ADMIN | manage apps, ingest keys, and members below owner |
| MEMBER | view all app data, dismiss advice, create apps |
| VIEWER | read-only |

A single Fastify `preHandler` resolves the org from the route, loads the caller's
membership, and asserts a minimum role. Every org-scoped query is additionally filtered
by `orgId` in the query itself rather than relying on the guard alone, so a missing guard
cannot leak another tenant's rows.

`User.isPlatformAdmin` is a separate boolean, checked by its own guard, and is the only
thing that opens `/v1/admin/*`. It is not a role in the org model, because the vendor is
not a member of customer organizations.

Invites are single-use tokens with a 7-day expiry, addressed to an email and carrying the
role to grant.

### Routes

```
POST   /v1/ingest

POST   /v1/auth/signup | login | refresh | logout
GET    /v1/me

GET    /v1/orgs                                     orgs the caller belongs to
POST   /v1/orgs
GET    /v1/orgs/:org/members                        ADMIN+
POST   /v1/orgs/:org/invites                        ADMIN+
POST   /v1/invites/:token/accept
PATCH  /v1/orgs/:org/members/:id                    OWNER
DELETE /v1/orgs/:org/members/:id                    OWNER

GET    /v1/orgs/:org/apps
POST   /v1/orgs/:org/apps                           MEMBER+
GET    /v1/apps/:id                                 includes ingest health
GET    /v1/apps/:id/keys                            ADMIN+, prefixes only
POST   /v1/apps/:id/keys                            ADMIN+, full key returned exactly once
DELETE /v1/apps/:id/keys/:keyId                     ADMIN+

GET    /v1/apps/:id/queries?from&to&sort&model&op   ranked table
GET    /v1/apps/:id/queries/:sig                    detail, histogram, redacted sample
GET    /v1/apps/:id/queries/:sig/series?from&to     hourly or daily points
GET    /v1/apps/:id/alerts
PATCH  /v1/apps/:id/alerts/:id                      acknowledge
GET    /v1/apps/:id/advice
PATCH  /v1/apps/:id/advice/:id                      applied | dismissed

GET    /v1/admin/orgs                               platform admin only
GET    /v1/admin/orgs/:id
GET    /v1/admin/health
GET    /v1/admin/offenders
POST   /v1/admin/orgs/:id/suspend
```

## 6. Data model

```prisma
model User         { id, email @unique, passwordHash, name, isPlatformAdmin, createdAt
                     memberships, refreshTokens }
model Organization { id, name, slug @unique, plan, suspendedAt, createdAt
                     memberships, apps, invites }
model Membership   { id, userId, orgId, role, createdAt  @@unique([userId, orgId]) }
model Invite       { id, orgId, email, role, tokenHash @unique, expiresAt, acceptedAt }
model RefreshToken { id, userId, familyId, tokenHash @unique, expiresAt, consumedAt }

model App          { id, orgId, name, env, createdAt  @@unique([orgId, name, env])
                     keys, signatures }
model IngestKey    { id, appId, keyHash @unique, prefix, lastUsedAt, revokedAt, createdAt }

model QuerySignature {
  id, appId, hash, model, operation,
  filterShape Json, sortKeys Json, stages String[],
  redactedSample Json?, firstSeen, lastSeen
  @@unique([appId, hash])
  @@index([appId, lastSeen])
}

model QueryRollup {
  id, signatureId, bucketHour DateTime, count Int, totalMs BigInt, maxMs Int, hist Int[]
  @@unique([signatureId, bucketHour])
  @@index([bucketHour])
}

model QueryDailyRollup {
  id, signatureId, day DateTime, count Int, totalMs BigInt, maxMs Int, hist Int[]
  @@unique([signatureId, day])
}

model Alert  { id, signatureId, kind, detectedAt, details Json, acknowledgedAt }
model Advice { id, signatureId @unique, suggestion Json, rationale String, status, updatedAt }
```

Retention: hourly rollups are kept 7 days, compacted nightly into daily rollups which are
kept 90 days. `hist` is a fixed-length 8-element integer array in both, so percentiles
work identically over either resolution and a query spanning the boundary just sums both.

## 7. Analysis

Both features are computed from data the service already holds. Neither connects to the
customer's database, which keeps the security story to a single sentence.

### Trends, percentiles, regressions

`avgMs` is `totalMs / count`. `p95` and `p99` come from the histogram: find the bucket
containing the target rank, then interpolate linearly within that bucket's bounds. The
result is approximate by construction and the UI labels it `p95 ≈`.

A nightly-plus-hourly job flags two kinds of alert:

- **Regression** — the last complete hour's p95 for a signature is more than 2× the
  median of its p95 over the trailing 7 days, and the hour's `count` is at least 20. The
  count floor exists because a single cold query at 3 a.m. is not a regression, and
  without the floor every low-traffic signature alerts constantly.
- **New expensive signature** — first seen within 24 hours, with total wasted time in
  the top ten for the app. This catches a deploy that introduced a bad query, which is
  the most common real cause and which a pure-regression rule misses entirely (there is
  no baseline to regress from).

Alerts land in a table and surface in the dashboard. No email or Slack in v1.

### Index advice

Deterministic, derived from `filterShape` and `sortKeys` by the Equality–Sort–Range rule:
equality-matched fields first, then the fields the query sorts on in their sort order,
then range-matched fields. Fields classified `regex`, `ne` or `other` are excluded from
the suggestion and mentioned in the rationale as unindexable in this position.

```
Order.find({ status: 'paid', createdAt: { $gte: … } }).sort({ placedAt: -1 })
  → db.orders.createIndex({ status: 1, placedAt: -1, createdAt: 1 })
```

Advice is suppressed when the filter is only `_id`, when the shape is empty, and when an
identical suggestion is already dismissed. Suggestions are ranked by the wasted time of
their signature over the window, so the first row is the one worth acting on.

The UI states plainly that this is a heuristic derived from query shape, not a verified
plan — the service has never seen the customer's indexes or collection statistics. That
honesty is what makes `explain()`-based evidence a compelling v2 rather than a
contradiction of v1.

## 8. Web

Next.js 16 App Router, Tailwind, shadcn/ui. Server Components for data-backed pages,
calling the API with the caller's token forwarded.

**Home** (public). The install snippet is the hero — the product's entire claim is that
it takes one line, so the line is the first thing on the page. Below it: what gets
captured, the privacy statement, a screenshot of the query table, plan placeholders, and
a signup CTA.

**Customer dashboard**, scoped by an org switcher, then an app switcher, then a time range.

- *Overview* — slow-query volume over time, the five worst signatures by wasted time,
  open alerts, and ingest health stated in human terms ("last batch 30 seconds ago", or
  "no data yet — check the key in your app").
- *Queries* — sortable table: signature, count, avg, p95, max, total wasted time, last
  seen. Filterable by model and operation.
- *Signature detail* — latency histogram, hourly trend, the redacted sample, and the
  suggested index with a copyable `createIndex` call and apply/dismiss.
- *Alerts* — regressions and new expensive signatures, acknowledgeable.
- *Settings* — apps, ingest keys (create, copy once, revoke), members, invites, roles.

**Admin dashboard** (platform admin only) — organizations with app count and ingest
volume, per-org drill-in, platform ingest health (batches per minute, rejections, auth
failures, quota breaches), and the worst signatures across all customers. Read-mostly;
the only writes are suspending an org and revoking a key.

**Onboarding** is the first-run path and is built, not stubbed: signup creates an org,
the next screen creates the first app, the key is shown exactly once inside a ready-to-
paste snippet, and the dashboard polls until the first batch arrives and then flips to
live. Every empty state on every page says what to do next.

## 9. Testing

Test-driven throughout; each phase below ships with its tests.

- **SDK** — unit tests for signature generation, operator classification, redaction,
  histogram bucketing, buffer bounds and drop accounting, retry and backoff. An
  integration test against `mongodb-memory-server` proves the hooks fire on real
  mongoose operations, that models compiled before `init()` are still instrumented, and
  — asserted explicitly against the serialised payload — that no queried value appears
  anywhere in what would be sent.
- **API** — integration tests over a real Postgres for the upsert accumulation maths
  (including concurrent batches and histogram element-wise addition), the full RBAC
  matrix per route, refresh-token rotation and family invalidation, key revocation,
  quota enforcement, and the percentile and regression calculations against fixtures.
- **Web** — a Playwright run of the whole first-run path: sign up, create an app, copy
  the key, ingest a batch, see the query appear, open the detail, read the advice.

## 10. Delivery order

Each phase is independently shippable and verifiable.

1. `packages/contract` and `packages/sdk` with their tests; published to public npm as
   `@vivekumar08/query-analyser`.
2. `apps/api` skeleton, Prisma schema and migrations, ingest keys, `POST /v1/ingest`.
   Verified by pointing a real KISNA service at it.
3. Auth, RBAC, organizations, apps, members, invites.
4. Read APIs, nightly compaction, percentile maths, regression detection, index advice.
5. Customer dashboard, including onboarding and empty states.
6. Admin dashboard.
7. Marketing home.
