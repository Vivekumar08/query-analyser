# SQL and Prisma, Phase 1: PostgreSQL with Prisma 5–7 and `pg`

Date: 2026-10-30
Repo: `query-analyser` (`packages/sdk`, `packages/contract`, `packages/sdk-compat`, `apps/api`, `apps/web`). Builds on `feat/mongodb-driver-monitoring` at `45a054f` (SDK 0.3.0).
Roadmap: this is project 2 of 4 (project 1 was MongoDB driver monitoring). The user split project 2 into three roadmap phases: **Phase 1 (V1)**, Phase 2 (V1.1) and Phase 3 (V2). **This document covers Phase 1 only:** PostgreSQL, Prisma 5–7 and the native `pg` driver. Phase 2 (MySQL/`mysql2`, Drizzle, Kysely, N+1, request correlation, comparisons) and Phase 3 (EXPLAIN, index advice, joins/seq scans, MSSQL) are non-goals here. Nothing below may block them. Inside Phase 1, the work runs in four internal steps, A to D (see "Steps").

## Why

The user wants to extend the MongoDB analyser into "a unified, lightweight, database-agnostic query monitoring and performance analysis tool for Node.js applications", and not a Prisma-only tool. PostgreSQL with Prisma and `pg` comes first because it is the largest group of Node/TypeScript backends the SDK cannot see today. The SDK is MongoDB-only in every layer:
- `toWireItem` hard-codes `source: 'mongodb'` (`packages/sdk/src/index.ts:130`);
- the signature is a Mongo filter shape (`signature.ts:106-133`);
- the API writes Mongo index advice for every signature (`apps/api/src/analysis/jobs.ts:286-330`, `advice.ts`);
- the detail page always renders the advice card and the mongosh/Compass card (`apps/web/app/dashboard/[org]/[app]/queries/[sig]/page.tsx:109-122`).

## What the user decided (binding)

From the user's decisions document:
- **Scope:** PostgreSQL with Prisma ORM and native `pg` first. Prisma **5, 6 and 7** only (not 2–4), with version-specific compatibility tests. Use version-compatible mechanisms (query events, supported tracing APIs) and account for query engines, driver adapters and instrumentation API differences. **No deprecated middleware** (`$use`).
- **Architecture:** one shared query event format across integrations, with modular adapters and not one analytics engine per ORM. Capture ORM/model metadata when it is available; otherwise use normalized SQL. **Prevent duplicate recording** when ORM and driver instrumentation overlap.
- **Privacy:**
  - never collect parameter values by default;
  - replace SQL literals with placeholders;
  - send no credentials, connection strings or results;
  - normalization is **SQL-aware, not regex-only**;
  - **keep table and column names by default**, with optional identifier masking;
  - sampling and retention are configurable;
  - failures never interrupt app queries; overhead is minimal.
- **Packaging:** keep `@vivekumar08/query-analyser`. Integrations are optional dependencies, and the analytics engine and dashboard are shared. Publish separate integration packages "when needed". **No Prisma/SQL dependencies for MongoDB-only apps.** MongoDB stays backward compatible.
- **Dashboard:** one unified dashboard (overview, DB/ORM filters, history, slow queries, errors, app/env filtering) with database-specific detail views. The V1 metrics are: total queries, avg latency, P50/P95/P99, slow queries with configurable thresholds, frequency and total time, SQL fingerprinting with literals removed (`SELECT * FROM users WHERE email = ?`), error tracking and trends, filters by database/application/environment/ORM/operation, and a detail view (normalized SQL, timing, frequency, errors).
- **Phase 1 roadmap:** shared event schema refactor; SQL fingerprinting with privacy-safe normalization; `pg` instrumentation; Prisma 5–7 instrumentation; SQL in the existing dashboard; latency metrics, slow queries, frequency and errors; overhead, compatibility and duplicate-prevention tests.
- **Non-negotiable:**
  - zero app code changes beyond install and `init` "where supported";
  - no change to query behaviour;
  - minimal overhead;
  - no sensitive values stored by default;
  - MongoDB backward compatibility;
  - no duplicate events;
  - framework-independent;
  - multiple connections in one app;
  - fail safely.

The user's answers to this design's open questions (binding):
- **U1. Count every SQL statement, not only slow ones**, so P50 and totals are real. `thresholdMs` stays the definition of "slow" and the sample trigger.
  - At the per-app signature quota, the API accepts items for known signatures and drops only the new ones, instead of rejecting the whole batch with 429.
  - It records the number dropped, and the dashboard shows a notice.
  - This applies to Mongo too and is backward compatible: old SDKs simply see fewer 429s.
- **U2. Sampling is configurable in V1.** The SDK ships a SQL sample rate in 0.4. Retention stays the existing per-plan limits (30/90/365 days, `apps/api/src/plans.ts:22-24`). This is the user's V1 reading of "configurable sampling and retention".
- **U3. Request correlation moves to Phase 2 (V1.1)**, built together with N+1 detection, which needs the same per-request grouping.

## Goals, non-goals, anti-goals

**Goals:**
- A `pg` app, or a Prisma 6.1+/7 app on Postgres, sees its queries in the existing dashboard after `npm i` and `init({ apiKey, app })`. Prisma 5 and 6.0 need one documented setup line. That is accepted under "where supported" (controller's call).
- Each executed SQL statement is recorded exactly once. When it came through Prisma, it carries Prisma's model and operation.
- Mongo users see no change in hashes, payloads, dashboard or dependencies. Mongo payloads stay exactly as in 0.3. The only change Mongo apps notice is the API's new quota behaviour (U1), which means fewer 429s.

**Non-goals (Phase 1):**
- MySQL, MSSQL, Drizzle, Kysely and other ORMs.
- **Request correlation and N+1 / redundant-query detection.** Both move to Phase 2 (V1.1) by the user's decision (U3).
- EXPLAIN, SQL index advice and join/seq-scan diagnostics.
- Dashboard-side slow thresholds (Phase 2 idea, see "What is counted").
- The dashboard redesign (project 3).
- Encrypted real-value samples for SQL (`sampleKey` stays Mongo-only).
- `pg-native` (`pg.native`), `pg-cursor` and `pg-query-stream` timing. Submittables pass through untouched and uncounted.
- Prisma Accelerate and Data Proxy (`prisma://`), where no SQL is visible in-process.
- Error *messages*.
- Counting every Mongo command. Mongo stays slow-only in Phase 1.

**Anti-goals (a failure even if it works):**
- A literal or parameter value leaves the process. This covers the values in `params` of Prisma query events, pg `values`, error `message`/`detail`/`where` (Postgres puts row values there, e.g. `Key (email)=(a@b.c)`), and comments carrying data.
- A query's result, timing semantics, error or return shape changes. That includes promise identity, callback arity, sync throws and unhandled rejections.
- The same statement is counted twice, by `pg` and by Prisma, or by two SDK copies.
- Any Mongo hash, wire key or byte of a Mongo payload changes compared with 0.3.
- Mongo (slow-only) and SQL (all statements) counts are added into one total.
- A new runtime dependency, or a static `import` of `pg` or `@prisma/client`.
- Patching undocumented Prisma internals (`_request`, `_engine`, `$use`). Project 1 removed exactly this kind of fragility.

## Constraints

- SDK: zero runtime dependencies. Peers are resolved at runtime through `resolvePeer` (`drivers.ts:52`). Node `>=20`, so `node:async_hooks` `AsyncLocalStorage` and `performance.now()` are available.
- Contract: `ingestItemSchema` (`packages/contract/src/schema.ts:26-45`) strips unknown keys. So new optional keys are safe in both directions: a 0.1–0.3 sender to a new API, and a new SDK to an old API. `types.ts` and `runtime.ts` stay equal to the schema through `sdk-types-equality.test.ts`.
- API:
  - `hist` is exactly 8 buckets (`HIST_BOUNDS = [100,250,…,10000]`, `runtime.ts:7`), and a DB `CHECK` enforces it (`migrations/20260920152948_hist_length_check`);
  - the per-app quota is 5,000 signatures, and today the API rejects the whole batch with 429 when a batch would cross it (`ingest/routes.ts:7, 63-76`). The SDK treats a 429 as retry and merges the batch back (`transport.ts:144-154`, `index.ts:422-428`), so at the quota even known signatures stall;
  - the writer accumulates rollups with `ON CONFLICT` and sets signature columns once (`ingest/writer.ts:58-95`);
  - the payload's `thresholdMs` is validated but not stored anywhere.
- What `pg` offers (checked in `pg@8.23.0`):
  - **no `diagnostics_channel` / `TracingChannel` support**, so patching is the only zero-setup hook;
  - `Pool.prototype.query` checks a client out and calls `client.query` (`pg-pool/index.js:431-467`), so `Client.prototype.query` (`pg/lib/client.js:668`) is the one choke point;
  - `@prisma/adapter-pg` runs every statement as `this.client.query({ text, values, rowMode: 'array', types })` on a `pg.Pool` or `PoolClient` (`adapter-pg/dist/index.mjs:645`);
  - the adapter depends on its own `pg` (`^8.16.3`), which may be a different copy from the app's.
- What Prisma 7 offers (checked in `@prisma/client@7.10.0` `runtime/client.js`):
  - it reads a tracing helper **lazily, on every call**, from `globalThis.V7_PRISMA_INSTRUMENTATION.helper` or `globalThis.PRISMA_INSTRUMENTATION.helper`;
  - the helper interface is `isEnabled`, `getTraceParent`, `dispatchEngineSpans`, `getActiveContext` and `runInChildSpan`;
  - each client call runs in an `operation` span with attributes `{ method, model, name: "User.findMany" }`;
  - each SQL statement runs in a `db_query` span with `{ "db.query.text": sql }`;
  - `$on('query')` fires only when the client was constructed with `log: [{ emit: 'event', level: 'query' }]`, and its payload includes `params` (real values).

## Design in one paragraph

Two capture layers feed one SQL core. **The `pg` layer** wraps `Client.prototype.query` and is the only place a SQL statement is timed when the statement passes through `pg`. **The Prisma layer** installs a tracing helper on Prisma's documented global hook. It does two things:
- it puts `{ orm: 'prisma', model, operation }` into an `AsyncLocalStorage` frame for the duration of each Prisma operation;
- it records a statement itself only when that statement never reached the `pg` layer: the Rust engine without an adapter, or an adapter whose `pg` copy the SDK did not patch.

The core fingerprints the SQL with a hand-written Postgres lexer and folds the statement into the existing `Aggregator`. The aggregator's item now carries its own `source` instead of the hard-coded `'mongodb'`.

## Developer-facing API

- `pg` and Prisma 6.1+/7 apps: **no change**. `init({ apiKey, app })` resolves `pg` and `@prisma/client` if installed, and installs both layers. Order does not matter:
  - prototypes are read at call time, so clients and pools created before `init()` are covered;
  - Prisma reads the helper lazily (spike Q2 confirms this per major).
- **New `InitOptions` fields (controller's call S1):**
  - `pg?: object`: the app's `pg` module, for a copy the SDK cannot resolve, such as a bundled one;
  - `sql?: { maskIdentifiers?: boolean; sampleRate?: number }`, see "What is counted". The builder may rename `sampleRate`.
- `instrument(x)` (`index.ts:513`) also accepts a `pg.Pool` or `pg.Client`. It patches `x.Client.prototype` for a pool (a public pg-pool field) or `Object.getPrototypeOf(x)` for a client, once per prototype.
  - This is the one setup step for an adapter's private `pg` copy: `instrument(pool)` on the pool handed to `new PrismaPg(pool)`.
  - The SDK first tries to resolve `pg` from `@prisma/adapter-pg`'s own location (builder's call), so in most installs the step isn't needed.
- `init({ prisma })` is **not** needed for capture. It is accepted (controller's call S2) only to let the SDK read the client version, and the model-to-table map for raw-SQL fallbacks, without guessing.
- `shutdown()` removes the `pg` wrapper where it is still on top (otherwise the wrapper stays as a pass-through, exactly like `undoConnectWraps`, `drivers.ts:175-193`) and restores the previous Prisma helper.

## Capture: `pg` (8.x)

- **One wrapper, on `Client.prototype.query`, never on `Pool.prototype.query`** (or every pool query is seen twice). A `Symbol.for('query-analyser.pg-query-wrap')` record on the prototype guards against double wrapping across SDK copies, mirroring `CONNECT_WRAP`.
- **Forms:**
  - `(text, values?, cb?)` and `(config, values?, cb?)` with a callback: the callback is replaced by a wrapper of the same arity that records, then calls the original synchronously with the same arguments;
  - the promise form returns **the original promise**. The SDK observes it on a side branch (`p.then(ok, fail)`) whose rejection handler swallows only on that branch;
  - a submittable (`typeof config.submit === 'function'`) is passed through untouched and not counted in Phase 1;
  - a synchronous throw is re-thrown unchanged.
- **What is read:** only the SQL text (`text` or `config.text`) and `client.database`. The SDK never reads `values`, `connectionString`, `password`, `user`, `host` or any field of the result.
- **Timing:** `performance.now()` around the call, as float milliseconds. This is the time from `query()` to completion. It includes waiting in the client's own queue, but not pool checkout, because `Pool.query` checks out before calling `client.query`. The README says so.
- **Errors:** a failed statement records its SQLSTATE `code` (5 characters, e.g. `23505`) when it matches `/^[0-9A-Z]{5}$/`, and nothing else from the error.
- **Statement filter (controller's call S3):**
  - captured: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `WITH`, `VALUES`, `TABLE` and `CALL`;
  - ignored: transaction and session control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `SET`, `SHOW`, `RESET`, `DISCARD`, `DEALLOCATE`, `LISTEN`, …) and DDL.
  - This is an allow-list on the first keyword after comments. A `WITH` is classified by its main statement's verb.

## Capture: Prisma 5, 6, 7

| Prisma | How SQL runs | What the SDK uses | Setup |
|---|---|---|---|
| 7.x | JS query compiler, always through a driver adapter (`@prisma/adapter-pg` for `pg`) | `pg` layer for SQL and timing; helper's `operation` span for model/op | none |
| 6.1+ engine (no adapter) | Rust engine, SQL never in JS | helper (tracing GA): `operation` span plus engine `db_query` spans dispatched through `dispatchEngineSpans` | none, if spike Q2 confirms |
| 6.x with `adapter-pg` | engine → JS adapter → `pg` | `pg` layer for SQL; context propagation through the engine is unknown (spike Q3) | none |
| 5.x and 6.0 | Rust engine; tracing is a preview feature | helper only works with `previewFeatures = ["tracing"]` | **one documented line**, chosen by spike Q5 (controller's call: accepted) |

- **The helper (controller's call S4):** the SDK installs it on `globalThis[`V${major}_PRISMA_INSTRUMENTATION`]` and `globalThis.PRISMA_INSTRUMENTATION`, which are the public hook `@prisma/instrumentation` uses.
  - It reports `isEnabled() === true`.
  - It wraps the `operation` span's callback in an `AsyncLocalStorage.run({ model, operation: method })`. Raw calls (`$queryRaw`, `$executeRaw`) have no model, so their operation is the method and their model comes from the SQL.
  - It wraps each `db_query` span in a statement frame (next section).
- **When the app has its own OpenTelemetry `@prisma/instrumentation`:** the SDK keeps that helper and delegates every call to it, including span creation. It never replaces another tracer. If the app's instrumentation registers after `init()`, the SDK detects the swap on its next statement and re-wraps (builder's call: a property setter or a check per call). The spike checks both orders.
- **Rejected:** `$on('query')`. It needs `log` set at construction, is not zero-setup, and carries `params`. It stays a possible fallback for Prisma 5 and 6.0 only, per spike Q5, and the SDK must never read `params`. Also rejected:
  - `$extends`, which returns a new client and so needs a code change;
  - `$use`, which has been deprecated since 4.16 (the spike confirms in which major it was removed);
  - Prisma internals.

## Exactly one event per statement (duplicate prevention)

- **The unit is one executed SQL statement.** A Prisma `findMany` with `include` that runs two `SELECT`s gives two events, both labelled `User.findMany` (controller's call S5). An operation's whole latency, including serialisation, is not measured in Phase 1.
- **The rule:** whoever times the statement emits it, and only one layer can time it.
  1. Prisma's `db_query` span callback runs inside a frame `{ claimed: false }`.
  2. If the `pg` wrapper runs inside such a frame, it emits with the frame's Prisma metadata and sets `claimed = true`.
  3. When the span callback settles with the frame still unclaimed (no patched `pg` underneath), the Prisma layer emits with its own `performance.now()` timing.
  4. Engine spans from `dispatchEngineSpans` (Rust engine) are emitted only for an operation whose frame saw no `pg` claim.
  5. With no Prisma frame at all, `pg` emits as raw SQL (`orm` absent).
- **Two SDK copies:** the wrapper and the helper are each installed once per process through `Symbol.for` records. A second copy finds the record and does not stack.
- **Prisma 5/6 with an adapter:** the engine calls into JS through native callbacks, and the async context may not survive. In that case the `pg` events have no metadata, and suppressing engine spans needs a different key. Spike Q3 decides between two options: a per-operation claim count, or "ignore engine `db_query` spans for clients that use an adapter". Either way, exactly-once is a release blocker and metadata is best effort. The labelling rule under "Fingerprinting" lets a later labelled event fill a missing label.

## SQL fingerprinting and normalization

- **A hand-written Postgres lexer in the SDK (controller's call S6).**
  - Why not something else: `libpg_query` (native or WASM) and the JS SQL parsers are runtime dependencies or hundreds of KB, which breaks the zero-dependency rule.
  - What it is: a lexer, not a parser. It never throws, and it is pure.
  - Tokens:
    - `'…'` strings with `''` escapes;
    - `E'…'` strings with backslash escapes, plus `B'…'`, `X'…'` and `U&'…'`;
    - `$tag$…$tag$` dollar quotes;
    - `"…"` identifiers;
    - numbers (integers, decimals, exponents, `0x`/`0o`/`0b`, `_` separators);
    - `$n` parameters;
    - `--` comments and nested `/* */` comments;
    - `::` casts, operators and punctuation.
  - **When in doubt it replaces:** an unterminated string or dollar quote turns the rest of the text into one `?`.
- **Normalization:**
  - every literal and `$n` becomes `?`, as the user's example shows. `NULL`, `TRUE`, `FALSE` and `DEFAULT` stay;
  - `IN (?, ?, …)` and `ANY (ARRAY[?, …])` collapse to `IN (?)` and `ANY (ARRAY[?])`;
  - multi-row `VALUES (…), (…)` collapses to one tuple;
  - comments are removed. This matters: sqlcommenter or `traceparent` comments would otherwise make every call unique;
  - whitespace collapses to single spaces;
  - keywords become upper case and unquoted identifiers lower case, because Postgres folds them. Quoted identifiers keep their quotes and case.
- **Output:**
  - `sql`: the normalized text, capped at 16 KiB with a `…` marker. The fingerprint covers the full normalized text up to an input cap of 256 KiB; past it, the cap is part of the text, so the hash stays deterministic (builder sets the exact caps);
  - `operation`: Prisma's method, or the lower-case verb (`select`, `insert`, …);
  - `table`: the first target table of the main statement, after `FROM`, `INTO` or `UPDATE` at nesting depth 0, as written without quotes;
  - `model`: Prisma's model, else `table`, else `(sql)`.
- **The hash is the normalized SQL only, keyed by source (controller's call S7):** `sha256("postgresql\n" + normalizedSql).slice(0, 16)`. Model, operation and ORM are labels, not part of the hash. This has two consequences:
  - one statement captured through `pg` and through Prisma has one hash;
  - the source prefix keeps it from ever colliding with a Mongo hash, and Mongo hashes do not change.
- **The label rule (controller's call S7):**
  - the signature row's labels (`orm`, `model`, `operation`) are written on insert;
  - while the stored `orm` is null, an incoming event that carries an `orm` fills all three, in the same way `COALESCE` fills `source` today (`writer.ts:69`). So a later Prisma-labelled event replaces a `pg`-first raw label. Once `orm` is set, the labels never change;
  - when identical SQL comes from two Prisma methods (say `findFirst` and `findUnique`), the first label seen wins.
  - **Known limitation**, documented in the README: in that last case the ORM and Operation filters can under-report.
- **Stability across Prisma versions is not fully in our hands.** Prisma 7's query compiler generates different SQL from the 5/6 engine. Spike Q4 runs one fixed set of Prisma calls on 5, 6 (engine and adapter) and 7 and reports which fingerprints differ. The release notes say "a Prisma major upgrade can start new history for some queries". Within one Prisma version, the engine and adapter paths must give the same hash.
- **Identifier masking (`sql.maskIdentifiers`, default off):**
  - every identifier, table and column, becomes `t_` plus the first 8 hex characters of its sha256;
  - Prisma's model name is masked the same way;
  - turning the option on starts new hashes. The README says plainly that this hides names and is not encryption.
- **Cost:** an LRU from raw SQL text to fingerprint result (2,000 entries, texts at most 16 KiB; builder's call). Prisma and parameterised `pg` code repeat the same text, so the hot path is one `Map` lookup.

## The event schema (wire)

SQL items use the existing `IngestItem` (`types.ts:39-60`):

| Field | SQL value |
|---|---|
| `signature` | the normalized SQL, truncated to 400 |
| `hash` | as above |
| `model` / `operation` | as above |
| `collection` | the table |
| `source` | `"postgresql"` |
| `filterShape`, `sortKeys`, `stages` | `[]` (no SQL shape in Phase 1, so no Mongo advice can come from it) |
| `sample` | `null` |
| `encryptedSample` | absent |

**New optional item keys (controller's call S8).** They are sent on SQL items only. Mongo items stay exactly as in 0.3.

| Key | Bounds | Meaning |
|---|---|---|
| `orm` | 1–40 | `"prisma"`; absent for raw `pg` |
| `database` | 1–255 | the database name the statement ran on (`client.database`); not in the hash |
| `sql` | 1–16,384 | the full normalized SQL for the detail view |
| `errors` | int ≥ 0 | failed executions in this window |
| `errorCodes` | at most 8 entries of `{ code: 5 chars, count }` | top SQLSTATEs in this window |
| `histFine` | `FINE_HIST_SIZE` ints | all-statement histogram (see "What is counted") |
| `sampleRate` | number, 0 < r ≤ 1 | present only when below 1 |

Compatibility:
- **0.1–0.3 senders:** all of these keys are absent. The API reads `orm` as null, `errors` as 0, `histFine` as null and `sampleRate` as 1, and stores exactly as now.
- **An old API receiving 0.4 SQL items:** it strips the new keys and stores a usable row (SQL text as signature, `source: postgresql`). It writes no advice, because the filter shape is empty.
- **Deploy order:** API and web first, then the SDK publish, as in project 1.
- **Mongo ORM label:** a Mongo row's ORM is shown as "Mongoose / driver", derived from `source` alone (controller's call).
- **`source` naming:** `source` means the database system: `mongodb` or `postgresql`, later `mysql` and `mssql`. The ORM lives in `orm`. Project 1's text had floated `source: "prisma"`; this design replaces that (controller's call S9).

## What is counted

- **Every captured SQL statement is counted (the user's decision, U1).** Each one adds to `count`, `totalMs`, `errors` and a finer histogram `histFine`. The bounds are roughly `1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000` ms; the builder sets them in `runtime.ts`.
- **"Slow" is the SDK's `thresholdMs`** (default 100, configured per deployment through `init()`; controller's call). It keeps both of its jobs:
  - only statements at or over it go into the 8-bucket `hist`, which gives the slow count and keeps the regression rules unchanged;
  - it stays the sample trigger.

  The API stores the last `thresholdMs` it received per app (a new `App.thresholdMs` column), and the dashboard shows it next to every slow count. That satisfies "configurable thresholds". Thresholds set in the dashboard over `histFine` are a Phase 2 idea.
- **Mongo stays slow-only in Phase 1.** Its counts mean "slow queries (≥ threshold)", and are never added to SQL counts (see "API" and "Dashboard").
- **Errors:** a failed statement always increments `errors` and its code in `errorCodes`, whatever its duration. It counts toward `count`, `histFine` and, at or over the threshold, `hist`, like a success.
- **Sampling (the user's decision, U2; the mechanics are the controller's call S12):**
  - `sql.sampleRate` (0 < r ≤ 1, default 1) applies **only to statements under `thresholdMs`**. Slow statements and failures are always recorded, so slow detection and error counts stay exact.
  - The decision is made after timing and before fingerprinting, so a skipped statement costs only its timer.
  - A kept fast statement carries weight `1/r`. The aggregator sums weights, and on flush it rounds `count`, `histFine` and `totalMs` so that the bucket total equals `count` (the builder picks the rounding).
  - Every item from a sampling process carries `sampleRate`. The API keeps the lowest rate seen per rollup (`minSampleRate`, nullable).
  - The dashboard labels any figure whose window includes a rollup with a rate below 1 as **"estimated (sampled at N%)"**.
- **Retention:** unchanged. The per-plan daily retention is 30, 90 or 365 days, with 7 days of hourly rollups (U2).

## API (`apps/api`)

- **Quota (the user's decision, U1; applies to every source):**
  - at the 5,000-signature quota, `/v1/ingest` writes every item whose hash is already known and drops only items with new hashes beyond the quota;
  - it answers `202 { accepted, droppedNew }` instead of 429 (`ingest/routes.ts:63-76`);
  - the number dropped is recorded per app and hour (builder's call: a small table or counter columns), and the dashboard shows a notice when any were dropped in the selected window;
  - old SDKs need no change: they simply stop seeing quota 429s, which today stall even known signatures (see "Constraints").
- **Migration:**
  - `QuerySignature`: `orm`, `database`, `sqlText`, `lastErrorCode` (all nullable text);
  - `QueryRollup` and `QueryDailyRollup`: `errors Int @default(0)`, `histFine Int[]` (nullable, with a length `CHECK` like the existing one) and `minSampleRate Float?`;
  - `App`: `thresholdMs Int?`, plus the drop record above.
- **Writer:**
  - inserts the new columns, and applies the label rule (fill `orm`, `model` and `operation` while the stored `orm` is null);
  - accumulates `errors` and `histFine`, and takes the `LEAST` of `minSampleRate`, in the rollup upsert;
  - updates `App.thresholdMs`.
  - Compaction (`analysis/compaction.ts`) sums `errors` and `histFine` and keeps the minimum rate.
- **Advice:** `refreshAdviceForApp` (`jobs.ts:286`) skips signatures whose `source` is set and not `mongodb`. The detail route returns `advice: null` for them.
- **List route** (`analysis/routes.ts:40-56, 150-223`):
  - new filters `source`, `orm` and `database`, each a single string like `model`/`op`;
  - each row gains `source`, `orm`, `errors`, a `sampled` flag, and `p50`/`p95`/`p99`, taken from `histFine` when present and otherwise from `hist`, as today;
  - new sort key `errors`.
- **New `GET /v1/apps/:id/summary?from&to&source&orm` (controller's call S10):**
  - returns figures **per source**: statement count, total time, average, P50/P95/P99, slow count with the threshold, errors, and the sampled flag;
  - the Mongo entry is labelled "slow queries (≥ threshold)";
  - it also returns the quota-drop count for the window;
  - it never returns a cross-source total.
- **Series route:** adds `errors` and `p50`/`p99` to each point.
- **Percentiles:** `percentileFromHist` (`percentile.ts`) gains a bounds parameter, so one function serves both histograms.
- **Alerts:** the regression and new-expensive alerts are source-agnostic and stay as they are.

## Dashboard (`apps/web`)

- **Queries list** (`queries/page.tsx`, `QueryFilters`, `filters.ts`):
  - **Database** (source) and **ORM** selects next to Model and Operation. Their options come from the unfiltered window, as model and op do today;
  - a small source badge per row;
  - an **Errors** column;
  - SQL rows show `model.operation` as the title and the normalized SQL (truncated) as the second line, which needs no change to `toRowsView`;
  - the "estimated (sampled)" label and the quota-drop notice, when they apply.
- **Summary strip** above the table, fed by `/summary`:
  - **one group per source**, never a combined total: PostgreSQL shows total statements, average, P50/P95/P99, slow (with the threshold) and errors; MongoDB shows "slow queries (≥ threshold)" with its count, average and P95;
  - the app index route still redirects to `/queries`. A real overview page belongs to project 3 (controller's call S10).
- **SQL detail view**, chosen by `source !== 'mongodb'`:
  - the full `sqlText`, monospaced, with a copy button;
  - stat cards: calls, total time, average, P50/P95/P99, max, errors with the last SQLSTATE;
  - metadata: database, table, ORM, model.operation;
  - the latency histogram (fine buckets when present);
  - a trend with calls, P95 and errors.
  - **No advice card and no Compass card** for SQL. The Mongo detail view does not change.
- `dashboard-types.ts` gains the new optional fields, optional so a web build stays type-compatible with an API that has not been redeployed, as `source?` already is (`dashboard-types.ts:106-107`).

### Which V1 metrics exist today

| Metric (decisions §4) | Today | Phase 1 |
|---|---|---|
| Total queries | per-signature `count`, of slow queries only; no app-wide total anywhere | **new** for SQL (all statements, `/summary`) |
| Avg latency | per signature, list and detail (`avgMs`, `routes.ts:234, 368`) | app-wide per source is **new** |
| P50 | not computed anywhere | **new** |
| P95 | list, detail, series (approximated from 8 buckets, shown as `≈`) | kept; finer with `histFine` |
| P99 | detail only (`routes.ts:370`) | added to list and series |
| Slow queries, configurable threshold | SDK `thresholdMs` (everything captured is "slow"); the threshold is not stored or shown | kept, plus a slow count and the threshold shown |
| Frequency, total time | `count`, "Time wasted", sort by count or wasted | kept |
| Fingerprinting, literals removed | Mongo shape signatures only | **new** for SQL |
| Error tracking and trends | none: Mongo failures over the threshold are folded silently into counts (project 1) | **new** for SQL (`errors`, codes, trend) |
| Filter by application / environment | **exists**: an App is `(name, env)` (`schema.prisma:134`), chosen with the app switcher; ingest ignores payload `env` (key → app) | unchanged |
| Filter by database, ORM | `source` stored since 0.3 but not filterable | **new** |
| Filter by operation | **exists** (`op`) | unchanged |
| Detail view | Mongo-shaped | SQL variant **new** |
| Request correlation | none | Phase 2, by the user's decision (U3) |
| Alerts (regression, new expensive) | in the API (`jobs.ts`); never shown in the web | unchanged |

## Packaging and versions

- **Same package, `@vivekumar08/query-analyser` 0.4.0.**
  - New optional peers: `pg >=8 <9` and `@prisma/client >=5 <8`, both in `peerDependenciesMeta` and external in tsup.
  - Mongo-only apps install nothing new and load no SQL code paths beyond the lexer module.
  - No static imports: `AsyncLocalStorage` comes from `node:async_hooks`, which is built in.
- **When a separate package becomes necessary (controller's call S11):** only when an integration needs a runtime dependency (for example a native parser or `@opentelemetry/api`), adds more than about 30 KB minified to the core, or must ship on a third party's release cadence. None of these applies in Phase 1.
- **Target versions** (the spike confirms, narrows or widens each line):

| Library | Range | Status |
|---|---|---|
| `pg` | 8.x (oldest minor tested: the spike picks it) | supported, tested |
| `pg` 7 | — | out (last release 2020) unless the spike finds it free |
| Prisma | 7.x with `@prisma/adapter-pg` | supported, tested, zero setup |
| Prisma | 6.1+, engine and `adapter-pg` | supported, tested; zero setup if Q2 holds |
| Prisma | 5.x (latest 5.22) and 6.0 | supported, tested, with one documented setup line (Q5; accepted, controller's call) |

## Steps (the controller's structure, following project 1)

Phase 1 is built in four steps. "Phase" always means the user's roadmap phase (V1, V1.1, V2).

### Step A: spike

Short and throwaway, outside the repo. The output is `docs/superpowers/specs/2026-10-31-sql-prisma-spike.md`, run against local Postgres on `:5432` in a throwaway database that is dropped afterwards. It answers:
1. **`pg` choke point:**
   - On each 8.x minor tested, do `Pool.query`, `PoolClient.query`, `adapter-pg`, a callback, a promise and a `name`d prepared statement all pass through `Client.prototype.query` exactly once?
   - Does `adapter-pg` resolve the app's `pg` copy under npm, pnpm and yarn?
   - Confirm there is no diagnostics channel.
2. **The Prisma helper, per major (5.22, 6.0, 6.1+, latest 6, latest 7):**
   - Is the global read without `previewFeatures`, lazily or at construction?
   - What are the span names and attributes (`operation`, `db_query`, the engine span format and timing)?
   - Does `AsyncLocalStorage` reach the adapter's `pg` call?
   - What does `isEnabled() === true` cost, and does it change the SQL (traceparent comments)?
   - How does it coexist with `@prisma/instrumentation`, in both registration orders?
3. **Prisma 5/6 with `adapter-pg`:** does context survive the engine→JS hop? Pick the exactly-once rule from the two options in "Exactly one event per statement".
4. **Fingerprint stability:** one fixed set of Prisma calls on 5/6 (engine), 6 (adapter) and 7. List the fingerprints that differ, with raw SQL that has values removed.
5. **The Prisma 5 / 6.0 setup line:** `previewFeatures = ["tracing"]` or `log` events with `init({ prisma })`. Pick the one that is smaller and leaks nothing.
6. **Shape count:** distinct statements on a realistic Prisma app with every statement counted.
   - **Pass:** the reference workload stays under 1,000 distinct shapes, a fifth of the 5,000 quota.
   - **Fail:** the plan proceeds with the documented fallback: the API's drop-only-new-shapes quota behaviour, plus `sql.sampleRate`. The spike reports which shapes dominate.
7. **The final supported-version table.**

If any answer contradicts this spec, the spike document says so, and the user is told before Step B starts.

### Step B: core

- Contract keys, SDK types and the equality test.
- Make `source` per item in `toWireItem` and the `Aggregator`, and add weighted counting for sampling.
- The lexer and fingerprint module, the `pg` wrapper, the Prisma helper, the claim frame, and `instrument(pool)`.
- API:
  - quota partial-accept and the drop record;
  - migration and writer, including the label rule and `App.thresholdMs`;
  - the advice gate;
  - list/summary/series changes.
- Web: filters, the per-source summary strip, the sampled label, the quota notice and the SQL detail view.
- Mongo payloads stay byte-identical to 0.3. All existing tests keep passing, except the quota-429 tests, which are rewritten to the new behaviour rather than deleted.

### Step C: compatibility and regression tests

In `packages/sdk-compat` and `apps/api`, against real Postgres:
- **Matrix:** `pg` 8 (oldest tested minor and latest); Prisma 5, 6.0, 6 latest (engine and `adapter-pg`) and 7 (`adapter-pg`). Each Prisma major needs its own generated client, so the builder chooses the mechanism (fixture directories with their own `package.json`, or npm aliases as for Mongo).
- **Exactly-once:** N Prisma operations and M raw `pg` queries on a shared pool give exactly the expected statement count. A test-side counter of statements at the server is the reference. Every Prisma statement carries its model and operation, and two SDK copies loaded at once still count once.
- **Label rule:** a `pg`-first row is relabelled by a later Prisma event once, and never again.
- **Query behaviour:** results, errors, promise identity, callback arity and sync throws are unchanged with and without the SDK. Submittables are unaffected.
- **Privacy:** canary values in literals, `$n` params, comments, dollar quotes, `E''` strings, and error details from a unique violation never appear in any payload.
- **Fingerprints:** a corpus test (Prisma SQL of each major, hand-written edge cases) with golden outputs and hashes.
- **Sampling:** with r = 0.1 over a known workload, scaled counts are within a stated tolerance, slow statements and errors are exact, and the API and dashboard label the window as sampled.
- **Quota:** a batch at the quota stores its known items, drops only its new ones, returns `droppedNew`, and records the drop; the dashboard shows the notice. Covered for a 0.3 Mongo payload too.
- **Totals never mix:** `/summary` with Mongo and SQL data returns separate per-source figures.
- **Multiple connections:** two pools to two databases.
- **Overhead:** N statements with the SDK on and off, for `pg` and for each Prisma major, at sample rates 1 and 0.1. Report the added cost in the release notes; there is no fixed pass/fail number, as in project 1.

### Step D: release prep (0.4.0)

- Publish to npm **only after the user says so.**
- README:
  - the Postgres/Prisma setup and the supported-version table;
  - **the setup steps, side by side:**
    - the Prisma 5 / 6.0 line. If it is `previewFeatures = ["tracing"]`, the README states that this is a schema change that needs `prisma generate`, and gives the alternative (`log` query events plus `init({ prisma })`);
    - `instrument(pool)` for an adapter's private `pg` copy;
  - what is timed (statement round trip, not pool wait);
  - `thresholdMs` as the slow definition, `sql.sampleRate` and what "estimated" means, and masking;
  - known limitations: a Prisma major upgrade can start new history for some queries, and identical SQL from two Prisma methods carries the first label, so the ORM and Operation filters can under-report.
- Web copy that says MongoDB only (`apps/web/app/page.tsx:47`, `components/onboarding/InstallStep.tsx:157-197`) gains Postgres and Prisma. The package `description` and `keywords` too.

## Rulings left to the builder

- Lexer details and caps; the LRU size; the fine histogram bounds.
- Rounding for weighted counts.
- The name of the sample-rate option.
- File layout (for example `src/sql/` and `src/integrations/{pg,prisma}.ts`).
- How the helper re-wraps after a late `@prisma/instrumentation` registration.
- The storage of the quota-drop record.
- The test-matrix mechanism.
- How `table` is chosen for statements with no `FROM`.
