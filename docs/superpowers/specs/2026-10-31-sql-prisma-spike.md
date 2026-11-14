# SQL / Prisma / pg: spike results

Date: 2026-10-31
Spec: `2026-10-30-sql-prisma-postgres-design.md`, "Step A: spike".
Branch: `feat/sql-prisma-postgres`. The spike code was throwaway and lived outside the repo. The throwaway database was dropped at the end, no spike processes were left running, and the credential files were deleted.

## Setup

- Node v26.7.0, PostgreSQL 14.19 (Homebrew) on `localhost:5432`. Everything ran in a throwaway database, `qa_sql_spike`. Each Prisma version reset the `public` schema and ran `prisma db push` with its own CLI before its workload. The URL came from `apps/api/.env` and was never printed.
- Packages were installed with `--ignore-scripts`. `prisma generate` was the only Prisma step run, and it fetched the engines itself.
- `pg` minors were installed side by side as npm aliases. Each Prisma version had its own folder with `prisma`, `@prisma/client`, `@prisma/adapter-pg` and `@prisma/instrumentation` at the same version, plus `pg@8.23.1`.

| Folder | Prisma | Adapter's `pg` dependency | Generated clients |
|---|---|---|---|
| `p5` | 5.22.0 | peer `^8.11.3` | `plain` (`driverAdapters`), `tracing` (`driverAdapters`, `tracing`) |
| `p60` | 6.0.1 | peer `^8.11.3` | `plain`, `tracing` |
| `p61` | 6.1.0 | peer `^8.11.3` | `plain` |
| `b682`, `b6140` | 6.8.2, 6.14.0 | n/a (engine only) | `plain`, used to bisect Q4 |
| `p6` | 6.19.3 (latest 6) | **dependency** `^8.11.3` | `plain` |
| `p7` | 7.10.1 (latest 7) | **dependency** `^8.16.3` | `plain` (`prisma-client-js`, `prisma.config.ts`) |
| `pgm` | `pg` 8.0.3, 8.4.2, 8.7.3, 8.11.6, 8.13.3, 8.16.3, 8.20.0, 8.23.1 | | |

The test schema has 10 models (User, Profile, Category, Post, Tag (implicit m-n with Post), Comment, Product, Order, OrderItem, Review) and 2 enums.

The main probe was `probe.js <dir> <client> <engine|adapter>`. It does four things:
- It puts accessor properties on `globalThis` for `PRISMA_INSTRUMENTATION` and `V5`–`V8_PRISMA_INSTRUMENTATION`, which log every read and write with the phase it happened in: `load`, `construct`, `connect` or `workload`.
- It installs an SDK-like helper that logs every call and runs each `runInChildSpan` callback inside an `AsyncLocalStorage` frame.
- It wraps `Client.prototype.query` on the app's `pg` copy and on the adapter's, and records the ALS frame chain each statement runs under.
- Optionally (`--qlog`), it subscribes to `$on('query')`. Only `query`, `duration`, `target` and the key list were recorded; `params` were never read.

## Decisions in one place

1. **`Client.prototype.query` is the single choke point on every `pg` minor from 8.0.3 to 8.23.1.** Each form passes through it exactly once: `Pool.query`, `PoolClient.query`, `Client.query`, callbacks, promises, configs, `rowMode: 'array'`, and named statements (each execution counts). There is no `diagnostics_channel` anywhere in the `pg` packages. **Support `pg >=8.0 <9`.**
2. **Resolve `pg` from `@prisma/adapter-pg`'s own location.** With npm, pnpm and yarn alike, the adapter shares the app's copy when the versions are compatible, and gets a private copy when they are not. For a private copy, `instrument(pool)` cannot help: the app's pool crashes the adapter, so the app must use the config form. Resolve the adapter's entry point, not `@prisma/adapter-pg/package.json`, which is not exported.
3. **Prisma 7 works exactly as the spec says.** The helper is read lazily, the statement runs inside the `db_query` span, ALS reaches `pg`, and every `db_query` span was claimed exactly once (46/46). The SQL text is identical with and without the helper, and the cost is 1–4 µs per op.
4. **Prisma 6.1+ on the engine path, without an adapter, works but has three costs that need a ruling:**
   - the helper must be in place before the engine loads (the first query or `$connect`);
   - engine spans only flow when the traceparent is *sampled*, and a sampled traceparent makes Prisma append `/* traceparent='…' */` to the SQL it sends;
   - it costs about +29–38 µs per op (+30–39% on a local `findUnique`).
5. **Prisma 5/6 with `adapter-pg`: the async context does not survive the engine→JS hop** on any version tested. The rule is "skip every engine `db_query` span that has a `js:query:*` child". The `pg` layer counts those statements without labels.
6. **Fingerprints:** engine and adapter give identical hashes within a version (22/22 calls). 5.22, 6.0.1 and 6.1.0 are identical. **6.x minors drift**: 16/22 calls are identical between 6.1 and 6.19, and 21/22 between 6.19 and 7.10.1.
7. **Prisma 5 / 6.0 setup line: `previewFeatures = ["tracing"]`** (one schema line plus `prisma generate`; no app code; no parameter values anywhere). Use a **constant** sampled traceparent. On these versions, statements get the `prisma` ORM label but take their model from the SQL table.
8. **Shape count passes:** 156 distinct shapes on Prisma 7.10.1, 146 on 6.19.3 and 188 on 5.22.0, against the 1,000 line. Prisma ≤6.1 `createMany` has a column-order bug that multiplies `INSERT` shapes.
9. **Batched calls are mislabelled:** `$transaction([...])`, and requests Prisma batches in the same tick, carry the label of the batch's first operation (Prisma 7 and 6.x). The builder needs a fallback rule (proposed in Q2).
10. **`$use` was removed in 6.14.0.** It exists in 5.22 through 6.13 (checked in the 6.9–6.13 tarballs) and is gone in 6.14.0, 6.19.3 and 7.10.1.

## Q1. The `pg` choke point

Script: `q1-pg.js <pg path>`, run for each of the 8 minors. It wraps `Client.prototype.query` and `Pool.prototype.query` and tags every statement with a comment.
```
[pg@8.0.3]  {"poolClientIsPgClient":true,"pool_promise":1,"pool_cb":1,"pool_cb_values":1,"pool_config":1,"poolclient_promise":1,"poolclient_cb":1,"named_twice":2,"rowmode_config":1,"err_code":"42P01","error_promise":1,"submittable":1,"client_promise":1,"client_database":"qa_sql_spike","Pool_prototype_query_calls":4,"total_wrapper_calls":12,"untagged":[]}
[pg@8.23.1] (identical; also 8.4.2, 8.7.3, 8.11.6, 8.13.3, 8.16.3, 8.20.0)
```
- **Exactly once on every form and every minor.** Each of the 4 `Pool.query` calls reached the wrapper exactly once. A named statement executed twice counts twice. The wrapper sees no internal statements of `pg`'s own (`untagged: []`).
- Where it happens in the source:
  - `Pool.query` checks out a client and calls `client.query`: `pg-pool/index.js:431` and `:467` (3.14.0), and `:325` and `:360` in the oldest pool `pg@8.0.3` allows (3.1.1);
  - `Client.prototype.query` is `pg/lib/client.js:668` (8.23.1, a class method) and `:481` (8.0.3, an assigned function). Both are patchable the same way.
- **A submittable** (`new pg.Query(...)`) also goes through `Client.prototype.query`, so the wrapper must detect `typeof config.submit === 'function'` and pass it through, as the spec says.
- `pool.Client === pg.Client` on every minor, so `instrument(pool)` can reach the prototype through `pool.Client`.
- `client.database` holds the database name on every minor.
- **No diagnostics channel:** a search for `diagnostics_channel|tracingChannel|TracingChannel` over all installed `pg`, `pg-pool`, `pg-protocol` and helper packages for 8.0.3–8.23.1 found 0 files.
- Caveat: every alias resolved `pg-pool` 3.14.0, because `^3.x` allows it. The 3.1.1 source shows the same call path.

**`adapter-pg` reaches the same choke point.** The adapter calls `this.client.query({ name, text, values, rowMode: 'array', types })`:
- in 7.10.1 at `adapter-pg/dist/index.mjs:645` (`index.js:681`), as the spec cites;
- in 6.19.3 at `index.js:654`, and in 5.22.0 at `index.js:428`.

On Prisma 7, all 46 `db_query` spans were claimed by exactly one `pg` call. The only `pg` calls outside a `db_query` span were 5 `BEGIN`s, which run in `start_transaction` and are filtered out anyway.

**Does the adapter use the app's `pg` copy?** Script: `resolve.js`. Each project was installed with the package manager named and `--ignore-scripts`; the script compares the real paths of `require.resolve('pg')` from the app and from the adapter.
```
npm-pg8231-ad7   app pg 8.23.1 | adapter pg 8.23.1 | same file: true  | same module object: true
npm-pg8116-ad7   app pg 8.11.6 | adapter pg 8.23.1 | same file: false | same module object: false
npm-pg8231-ad6   app pg 8.23.1 | adapter pg 8.23.1 | same file: true  | same module object: true
npm-pg8116-ad5   app pg 8.11.6 | adapter pg 8.11.6 | same file: true  | same module object: true
(pnpm 9.15.9 and yarn 1.22.22: the same four results)
```
- When the app's `pg` satisfies the adapter's range, all three package managers share one copy.
  - adapter-pg 5.22–6.1 declares `pg` as a *peer*, so it always uses the app's copy.
  - From some 6.x minor onwards it is a *dependency* (`^8.11.3` in 6.19.3, `^8.16.3` in 7.10.1).
- **With an app `pg` older than 8.16.3 and Prisma 7, the adapter gets a private 8.23.1** under all three managers.
- In that case, `new PrismaPg(appPool)` **crashes the app** (`mismatch.js`):
  - `poolOrConfig instanceof pg.Pool` fails (`adapter-pg/dist/index.js:796`), so the pool object is used as a config;
  - the result is `TypeError [ERR_INVALID_ARG_TYPE] … Writer.addCString`.

  So a private copy only works with the config form, `new PrismaPg({ connectionString })`. There, the adapter creates its own pool from its private `pg`. `mismatch-cfg.js` shows the statement going through that private copy:
  ```
  config form (connectionString)
  statement went through: app pg wrapper 0 | adapter-private pg wrapper 1
  ```
- **Decision:** the SDK resolves `@prisma/adapter-pg` from the app, then resolves `pg` from the adapter's directory, and patches that copy too. Two details:
  - resolve the main entry and walk up, because `require.resolve('@prisma/adapter-pg/package.json')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`;
  - Node caches by real path, so pnpm's symlinks need no special case.

  `instrument(pool)` stays for bundled `pg`, but it is not the remedy for the adapter's private copy.

## Q2. The Prisma helper, per major

Scripts: `probe.js` (one run per version, path and option), `facts.js` (summary) and `bench.js` (cost).

| | 5.22.0 | 6.0.1 | 6.1.0 | 6.19.3 | 7.10.1 |
|---|---|---|---|---|---|
| Global read without `previewFeatures` | **no**: the helper is fixed to a no-op at construction (`library.js:130` `this._tracingHelper=Il(this._previewFeatures)`; `Il` returns the live helper only if `"tracing"` is listed, `library.js:121`) | **no** (same code) | yes | yes | yes |
| Keys read | `PRISMA_INSTRUMENTATION` | same | `PRISMA_INSTRUMENTATION` only | `V6_…`, then the unversioned key | `V7_…` (the unversioned key only if `V7_` is unset) |
| When it is read | on every call (with `tracing`) | same | on every call (`construct:1, connect:7, workload:71`) | same | on every call (`connect:1, workload:91`) |
| Helper installed after `$connect` (`--lazy`) | JS spans yes; engine spans **yes** | same as 5.22 | JS spans yes; engine spans **no** | JS spans yes; engine spans **no** | everything works |
| Interface | `createEngineSpan` | same | `dispatchEngineSpans` | same | `dispatchEngineSpans(…, cb)` (`client.js:65`) |
| ALS reaches the adapter's `pg` | **no** (18/18 calls with no frame) | **no** | **no** | **no** | **yes** (46/46) |
| SQL changed by a sampled traceparent | yes (comment) | yes | yes | yes | **no** (51/51 texts identical) |
| Cost of the helper being on | +16–20 µs/op | n/a | n/a | +29 µs (unsampled), +38 µs (sampled) | +1–4 µs/op |

**Spans and attributes (observed):**
- **JS spans, all majors:**
  - `operation` with `{ method, model, name: "User.create" }`;
  - raw calls: `{ method: "queryRaw", name: "queryRaw" }`, with no model;
  - `transaction` with `{ method: "$transaction" }`;
  - also `serialize`, `connect` and `disconnect`. 6.1+ adds `detect_platform` and `load_engine`.
- **7 only:**
  - `compile`, with `{ models: [...], actions: [...] }`;
  - `start_transaction` and `commit_transaction`;
  - `db_query`, called as `runInChildSpan({ name: "db_query", kind, attributes: { "db.query.text", "db.system.name" } }, cb)` around the statement (`client.js:11`), and only when `isEnabled()` is true.
- **Engine spans in 5.22 and 6.0.1:**
  - shape: `createEngineSpan({ span: true, spans: [one span] })`, one span per call;
  - fields are snake_case (`trace_id`, `span_id`, `parent_span_id`, `start_time`/`end_time` as `[sec, ns]`);
  - `prisma:engine:db_query` carries `db.statement`;
  - **delivery happens outside the operation's ALS frame** (frame `""`).
- **Engine spans in 6.1+:**
  - shape: `dispatchEngineSpans(spans[])`, one batch per request;
  - fields are camelCase (`id`, `parentId`, `startTime`/`endTime` as `[sec, ns]`);
  - `prisma:engine:db_query` carries `db.query.text`;
  - delivery happens **inside the operation's frame** (`frame at delivery: "operation(User.create)"`).
- **Privacy:** no engine or JS span carries parameter values. The adapter's `js:query:args` span carries only `prisma.db_query.params.count`. Every `$on('query')` event carries `params`.

**The engine needs a sampled traceparent, and a sampled traceparent rewrites the SQL.** Run on 6.19.3, engine path, with the `q2` workload of 18 statements:
```
tp=noop       qevents 18 with traceparent comment 0  engine db_query spans 0  with comment 0
tp=unsampled  qevents 18 with traceparent comment 0  engine db_query spans 0  with comment 0
tp=sampled    qevents 18 with traceparent comment 11 engine db_query spans 18 with comment 2
```
- The same holds on 5.22 with `tracing` (unsampled: 0 engine spans).
- On 6.x with an adapter, the comment also reaches `pg`: 11 of 18 `pg` texts had it.
- Sometimes the comment is inside a subquery: `… OFFSET $1 /* traceparent='00-…-01' */) AS "sub" /* traceparent=… */`.
- **Prisma 7 never adds it.**
- So the engine path **cannot** be observed without changing the SQL text that reaches Postgres. Results do not change. The lexer drops comments, so hashes do not change either.

**Lazy install on 6.1+:** `enableTracing: this.tracingHelper.isEnabled()` is read once, when the engine is created (`library.js:112`, 6.1.0 and 6.19.3).
- With the helper installed after `$connect`: `lazy: spans recorded by q before helper install 0 | after 2`, with `engineSpans {}`.
- So on the 6.1+ engine path, `init()` must run before the client's first query or `$connect`. Otherwise the SDK gets model/op spans but no statements.
- 5.22 and 6.0 with `tracing` are not affected; their engine spans flowed after a late install.

**Cost** (`bench.js`, 3,000 sequential `findUnique` on local Postgres after 300 warm-up calls, two runs each):
```
7.10.1 adapter none 76.9 / 75.2 us/op      helper 81.3 / 76.5
6.19.3 engine  none 99.3 / 99.4            helper unsampled 128.7 / 128.2   helper sampled 137.5 / 138.6 (5.5 engine spans per op)
5.22.0 engine  none 96.0 / 94.2            tracing client, no helper 99.8 / 100.7   tracing + helper sampled 115.6 / 115.6
5.22.0 tracing + helper, unique traceparent per request: 151.5 / 150.8   (statement-cache misses; 6.19.3: 144.4 / 142.0, no change)
```

**Coexistence with `@prisma/instrumentation`** (`--instr=before|after`, with a real `AsyncLocalStorageContextManager` and an in-memory exporter):
- The app's instrumentation writes the globals by **plain assignment** and removes them with `delete`:
  - 6.19.3 `instrumentation/dist/index.js:238-243`;
  - 7.10.1 `setGlobalTracingHelper`/`clearGlobalTracingHelper`, `:89-97`;
  - 5.22 writes only `PRISMA_INSTRUMENTATION` (`chunk-PVBRMQBZ.js:35-43`).

  So a configurable accessor that the SDK defines on `globalThis` sees every swap (`writes […@connect:ActiveTracingHelper]`).
- **App instrumentation first, SDK second:** the SDK delegates and both sides see everything, on 5.22, 6.19.3 and 7.10.1:
  ```
  7.10.1 delegate ActiveTracingHelper  otelSpans {"prisma:client:operation":9,"prisma:client:db_query":15,…}  js db_query spans 15 claimed 15
  ```
- **SDK first, app second:** the app overwrites the global. The SDK then sees only the spans created before the swap (7.10.1: `runInChildSpan: 1`), until it re-wraps. The spike confirms the swap is detectable; the re-wrap mechanism is the builder's call.
- **New finding: on the engine path, a delegating SDK sees only what the app samples.**
  - Run: app `TraceIdRatioBasedSampler(0.1)`, `fixed` workload of 24 operations.
  - Result: the SDK received 8 (6.19.3) and 9 (5.22.0) engine `db_query` spans, against 53 without the app tracer.
  - The SDK could force the sampled flag and not forward the engine spans of unsampled operations to the app's helper. That touches the app's trace headers, so it needs a ruling (see Contradictions).

**Labels in batches (Prisma 7 and 6.x).** Script: `labelcheck.js` with the `conc` workload, which runs 6 calls in `Promise.all`, including a `$transaction([User.count, Product.count])`.
```
7.10.1  differing: {"User.findUnique -> Product":5, "User.findUnique -> Post":1, …}   ("User.findMany -> Post" is a legitimate include)
6.19.3  differing: {"User.findUnique -> Product":5, …}
```
- Every statement of a batch, whether `$transaction([...])` or a same-tick batch that Prisma flushes together, runs in the ALS frame of the operation that started the batch.
- **Proposed rule:** when the frame's model maps to a table that is not the statement's main table, *and* the frame is inside a `transaction` span or saw more than one `operation` span in the same tick, label the statement from its SQL table instead. The builder decides; the hash is not affected.

## Q3. Prisma 5/6 with `adapter-pg`: exactly-once rule

- **Context does not survive the engine→JS hop.** On 5.22.0, 6.0.1 (both with and without `tracing`), 6.1.0 and 6.19.3, every adapter `pg` call ran with no ALS frame (`pgCalls 18 by innermost frame {"NONE":18}`). So "a per-operation claim count" cannot be implemented.
- **Rule chosen: the Prisma layer skips every engine `db_query` span that has a `js:query:*` child. The `pg` layer counts those statements.** A `js:query:*` child is the adapter marker: an engine-only client never produces one.

  Evidence (`fixed` workload, 22 calls, through the adapter):
  ```
  5.22.0 tracing adapter: db_query 18 with js:query child 18 (all js children delivered before parent: 18)  js:query parent 0
  6.19.3 adapter:         db_query 15 with js:query child 15 (all js children delivered before parent: 15)
  non-control statements: engine db_query 41 = pg calls 41 (both versions)
  ```
  - Children end first, so they are delivered first: before the parent on 5.x (one span per call), or in the same batch on 6.1+. The decision therefore needs no buffering beyond the current batch on 6.1+, and a set of "ids that have a `js:query` child" on 5.x.
- **Residual risk:** if the adapter's `pg` copy is *not* patched, these statements are lost (undercounted, never duplicated).
  - Q1's resolution makes this rare.
  - The builder may add a guard: if the Prisma layer skips adapter spans while the `pg` layer has seen no statements in the adapter's call shape (`rowMode: 'array'` plus a `types` override), emit from the spans instead.
- **Labels:** the `pg` events have no model or operation on these versions. On 6.1+ the builder can recover them best-effort: the `js:query:sql` spans arrive inside the operation frame, so a raw-SQL → `{ model, operation }` map can label *later* `pg` executions of the same text. The API's label rule then relabels the row once.

## Q4. Fingerprint stability

Script: `probe.js … --workload=fixed --nohelper --qlog` on each path, then `q4.js`.
- The `fixed` workload is 22 labelled calls: CRUD, nested create, `connectOrCreate`, include, select, `OR`/`in`, increment, `updateMany`, `count`, `aggregate`, `groupBy`, `upsert`, batch and interactive transactions, `$queryRaw`, and a cascade delete.
- SQL came from `$on('query')` on the engine path and from the `pg` wrapper on the adapter path. Control statements were excluded. A crude normalizer was used (literals and `$n` → `?`, IN lists and `VALUES` collapsed, comments dropped).

```
pair 5.22.0 engine vs 5.22.0 adapter: identical calls 22/22
pair 6.19.3 engine vs 6.19.3 adapter: identical calls 22/22
pair 5.22.0 engine vs 6.0.1 engine:  22/22      pair 6.0.1 vs 6.1.0: 22/22
pair 6.1.0 vs 6.8.2: 17/22   6.8.2 vs 6.14.0: 21/22   6.14.0 vs 6.19.3: 18/22   6.1.0 vs 6.19.3: 16/22
pair 6.19.3 adapter vs 7.10.1 adapter: identical calls 21/22
pair 5.22.0 engine vs 7.10.1 adapter: identical calls 15/22
```

The statements that differ (`q4diff.js`; values removed by the normalizer):

| Change | Where | Before → after |
|---|---|---|
| `count` / `groupBy` aliases | 6.1 → 6.8 | `SELECT COUNT(*) FROM (…)` → `SELECT COUNT(*) AS "_count._all" FROM (…)` |
| Same, separator | 6.14 → 6.19 | `AS "_count._all"` → `AS "_count$_all"` |
| `aggregate` aliases | 6.14 → 6.19 | `SELECT AVG("views"), MAX("views") …` → `SELECT AVG("views") AS "_avg$views", MAX("views") AS "_max$views" …` |
| `connect` / `connectOrCreate` lookups | 6.1 → 6.8 (by id), 6.8 → 6.14 (by unique) | `… WHERE ("public"."Tag"."name" = ? AND ?=?) OFFSET ?` → `… LIMIT ? OFFSET ?` |
| `contains` | 6.19 → 7.10 | `"title"::text LIKE ?` → `"title"::text LIKE (? \|\| ? \|\| ?)` |

- **Within one version, engine and adapter agree, as the spec requires.**
- The spec expects new history on a *major* upgrade. In fact, history also restarts on **6.x minor upgrades**, while 6.19 → 7 changed only 1 of 22 calls. The README limitation should read "a Prisma upgrade (including 6.x minors) can start new history for some queries".

## Q5. The Prisma 5 / 6.0 setup line

| | `previewFeatures = ["tracing"]` | `log: [{ emit: 'event', level: 'query' }]` + `init({ prisma })` |
|---|---|---|
| App change | one schema line, then `prisma generate` | a constructor option **and** an `init` argument |
| What the SDK gets | `operation` spans with model/op (in ALS), and engine `db_query` spans with SQL and `[sec, ns]` timing | SQL text and an **integer** ms `duration` |
| Model/op on statements | engine spans arrive outside the frame (`frame ""`) | events arrive outside any frame (`frames [""]`, even with `tracing`) |
| Parameter values in the payload | none (span attributes: `db.system` and `db.statement` only) | **yes**: every event carries `params` (`keys ["timestamp","query","params","duration","target"]`) |
| SQL sent to Postgres | gains `/* traceparent */` comments (a sampled traceparent is required) | unchanged |
| With an adapter | the Q3 rule applies (`js:query` child marker) | **duplicates the `pg` layer with no marker**: `target` is `quaint::connector::metrics` on both paths |
| Cost | +16–20 µs/op (constant traceparent) | not measured |

- **Decision: `previewFeatures = ["tracing"]`.** It is the smaller change (no code), the only option whose payload never contains parameter values, and the only one that can be de-duplicated against the `pg` layer.
- **Use a constant, process-wide sampled traceparent.** The engine spans can be linked to their operation (51/51 linked under concurrency, `link.js`), but only with a *unique* span id per request. That makes the comment text unique, misses Prisma 5's statement cache, and costs a further +35 µs/op (115.6 → 151.5 µs).
- So on 5.22 and 6.0, statements carry `orm: 'prisma'`, the operation as the SQL verb, and the model from the SQL table. Linking stays a later option.
- The README says this is a schema change and gives the `log` alternative, as the spec already requires.

## Q6. Shape count

The `big` workload in `workloads.js` behaves like a real app:
- 10 models with relations, seeded (6 categories, 10 tags, 40 users, 30 products, 80 posts);
- then 2,500 calls spread at random over **41 endpoint handlers**;
- the handlers use optional filters, a choice of sort, `include`/`select`/`_count` combinations, cursor and offset pagination, `IN` lists of 1–25 ids, `createMany` of 1–10 rows, nested writes (`connectOrCreate`, `set`, nested `create`), `count`, `aggregate`, `groupBy`, `distinct`, `upsert`, interactive and batch transactions, `$queryRaw` and `$executeRaw`, and `findUniqueOrThrow`.

Script: `q6.js`, using the crude normalizer from Q4 and excluding `BEGIN`/`COMMIT`/`SET`.
```
7.10.1 adapter  statements 5251  distinct raw texts 234  DISTINCT NORMALIZED SHAPES 156   (cumulative 1000:112 2000:126 4000:150 5251:156)
6.19.3 engine   statements 5075  distinct raw texts 239  DISTINCT NORMALIZED SHAPES 146
6.14.0 / 6.8.2  146 / 146      6.1.0 189      6.0.1 190
5.22.0 engine   statements 5075  distinct raw texts 317  DISTINCT NORMALIZED SHAPES 188   (cumulative 1000:116 2000:146 4000:179 5075:188)
```
**PASS:** 146–190 shapes, well under the 1,000 line. The count levels off after about 2,000 statements. That is about 4–5 shapes per endpoint, so an app with roughly 200 or more comparable endpoints would approach 1,000.

**Shape families** (7.10.1, by number of shapes):
```
SELECT Post 35 · SELECT User 33 · SELECT Product 28 · SELECT Tag 10 · SELECT Order 7 · SELECT OrderItem 4 · SELECT Category 4 · … · INSERT Tag 2 · INSERT User 2
by Prisma label: Post.findMany 32 · Product.findMany 24 · User.findMany 21 · User.findUnique 11 · Post.update 10 · Post.create 9
```
- **List endpoints with optional filters dominate.** Each subset of filters is its own `WHERE`, and each `include`/`select`/`orderBy` choice multiplies them; `findMany` accounts for most shapes.
- Relation loads (`… WHERE "authorId" IN (?)`) stay flat, because IN lists collapse. Without the IN collapse there would be 234 raw texts instead of 156 shapes.
- **Prisma ≤6.1: `createMany` emits columns in a random order on each call.** On 5.22, `INSERT INTO "Product" ("price","sku","stock","name")` and `("sku","price","stock","name")` appear as separate shapes, giving 23 `INSERT Product` and 23 `INSERT OrderItem` shapes. The INSERT Product/OrderItem shape counts are 48 (6.0.1) and 47 (6.1.0), but only 4 on 6.8.2 and 6.14.0. This is the main shape risk on old Prisma.
  - The lexer could sort the column list of an `INSERT … (cols) VALUES` for the fingerprint only (builder's call). Shapes would then be stable, at the cost of showing one canonical column order.
- The fallback (drop-only-new quota plus `sql.sampleRate`) is not needed, but stays as designed.

## Q7. Supported versions

| Library | Range | Status | Setup |
|---|---|---|---|
| `pg` | `>=8.0 <9` (tested 8.0.3, 8.4.2, 8.7.3, 8.11.6, 8.13.3, 8.16.3, 8.20.0, 8.23.1) | supported, tested; test 8.0.3 and latest in Step C | none |
| `pg` 7 | — | out (not tested) | — |
| Prisma 7.x + `@prisma/adapter-pg` | tested 7.10.1 | supported, zero setup | none |
| Prisma 6.1+ engine (no adapter) | tested 6.1.0, 6.19.3 | supported, with conditions | none, but `init()` must run before the first query or `$connect`; the SQL gains traceparent comments; about +30–39% per trivial op |
| Prisma 6.x + `adapter-pg` | tested 6.1.0, 6.19.3 | supported, exactly once; **labels best effort** (absent on the first execution) | none |
| Prisma 5.22, 6.0 | tested 5.22.0, 6.0.1 | supported, with model from the SQL table | `previewFeatures = ["tracing"]` |
| Prisma 5.0–5.21 | — | untested; same code path as 5.22 expected | same |
| Prisma 8 | — | out. **The `prisma` package's `latest` tag is now `8.0.0-rc.33`** (2026-11-06), while `@prisma/client`'s `latest` is 7.10.1, so `npm i prisma` installs the 8 RC. Keep the peer at `@prisma/client >=5 <8`. | — |

Suggested optional peers: `pg >=8 <9` and `@prisma/client >=5 <8`, as the spec has them.

## Contradictions with the spec

1. **"Order does not matter … Prisma reads the helper lazily."** This is true for Prisma 7, and true for 5.22/6.0 with `tracing`. **It is false for the 6.1+ engine path**: engine tracing is fixed when the engine is created, which happens on the first query or `$connect` (`library.js:112`). If `init()` runs later, the SDK records model/op spans but no statements. The README needs "call `init()` before the first query" for Prisma 6.1+ without an adapter, or the SDK warns when it sees operation spans but never an engine span.
2. **"No change to query behaviour" vs the engine path.** To get engine `db_query` spans, the helper must return a *sampled* traceparent (Q2 table). Prisma then appends `/* traceparent='…' */` to most of the SQL it sends, on 5.x, 6.0, 6.1+ and 6.x with an adapter. Results, errors and hashes do not change, but the SQL text in `pg_stat_activity` and server logs does. Measured cost on 6.19.3: +29–38 µs per trivial op. **Needs a controller ruling:** accept it (with a constant traceparent and a README note), or limit 6.1+ engine-path capture to model/op spans.
3. **Delegating to the app's `@prisma/instrumentation`:** on the engine path the SDK then sees statements only for operations the app's sampler keeps (8–9 of 53 at a 10% ratio). The spec assumes delegation is lossless. **Needs a ruling:** force the sampled flag and hold back the engine spans of unsampled operations from the app's helper, or accept the undercount on the engine path for OTel apps.
4. **Prisma 5/6 + adapter (the spec's open question):** context does not survive, so "a per-operation claim count" is impossible. The answer is the second option, made per-span: skip engine `db_query` spans that have a `js:query:*` child. `pg` events on these versions are unlabelled; best-effort relabelling is possible on 6.1+ (Q3).
5. **`instrument(pool)` as "the one setup step for an adapter's private `pg` copy":** a private copy only arises when the app's `pg` is outside the adapter's range. In that case, passing the app's pool to `PrismaPg` crashes inside the adapter (`instanceof` fails), so apps must use the config form, and there is no pool to hand to `instrument()`. The working mechanism is resolving `pg` from the adapter's location, which the spec lists as the builder's first try. It worked under npm, pnpm and yarn. `instrument(pool)` remains useful for bundled `pg`.
6. **"A Prisma *major* upgrade can start new history":** hashes also change across **6.x minors** (6.1 → 6.8 → 6.14 → 6.19), while 6.19 → 7 changed only 1 of 22 calls. The README wording should say "a Prisma upgrade (including minors)".
7. **"Every Prisma statement carries its model and operation" (Step C):** statements do carry a label, but in `$transaction([...])` batches and in same-tick batched requests, they carry the *first* operation's label (Prisma 6 and 7). The test needs the Q2 fallback rule or a relaxed assertion for batches.
8. **"When it came through Prisma, it carries Prisma's model and operation"** does not hold on Prisma 5.22 / 6.0 under the chosen setup line: the model comes from the SQL table and the operation from the SQL verb (Q5). Linking with a per-request traceparent works, but costs +35 µs/op on 5.22.
9. **Confirmed as the spec states:**
   - `pg` has no diagnostics channel;
   - `Client.prototype.query` is the choke point;
   - `adapter-pg/dist/index.mjs:645` is the call site in 7.10.1;
   - Prisma 7's helper interface and the `operation`/`db_query` attributes are as described;
   - `$on('query')` carries `params`.
   - `$use`, which the spec says is deprecated, is **removed in 6.14.0**.
