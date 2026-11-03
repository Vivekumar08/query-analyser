# Changelog

## 0.4.0

- **PostgreSQL capture** for `pg` 8 (`>=8.0 <9`, tested 8.0.3 to 8.23.1) and
  Prisma 5.22 to 7 (tested 5.22.0, 6.0.1, 6.19.3 and 7.10.1), with exactly one
  event per executed SQL statement. `pg` and Prisma 7 need nothing beyond
  `init()`; Prisma 5.22 and 6.x are captured through `@prisma/adapter-pg`, or
  on the engine path only when the app already enables Prisma tracing itself.
  The SDK never changes the SQL your database receives. A bundled `pg` the SDK
  cannot resolve: `init({ pg })` or `instrument(pool)`. See the README for the
  setup and the known limitations.
- **New optional peers:** `pg` (`>=8.0 <9`) and `@prisma/client`
  (`>=5.22 <8`). Mongo-only apps install nothing new. There are still no
  runtime dependencies.
- **SQL fingerprints with values removed:** every literal, `$n` parameter,
  comment and dollar-quoted body becomes `?` or is dropped before anything is
  buffered. SQL items carry no sample. Parameter values, results, error
  messages and connection strings never leave the process.
- **Every SQL statement is counted**, not only slow ones: errors (with their
  top SQLSTATE codes), P50/P99 and a fine latency histogram. `thresholdMs`
  still defines "slow".
- **`sql.sampleRate`** (default `1`) times only a fraction of fast, successful
  statements; slow ones and failures are never sampled. The dashboard labels
  such figures "estimated (sampled at N%)". **`sql.maskIdentifiers`** replaces
  table, column, schema and database names with keyed hashes; it is not
  encryption, and turning it on starts new history.
- **The API's quota is gentler** (any SDK version): at the 5,000-signature
  quota it still stores every item whose shape it already knows, drops only
  new shapes, and answers `202 { accepted, droppedNew }` instead of 429. You
  should see far fewer 429s.
- **Mongo is unchanged from 0.3:** the same payloads, key order and hashes, so
  Mongo history continues. Mongo stays slow-only, and its counts are never
  added to SQL counts.
- **Deploy order:** deploy the API and web before publishing or upgrading to
  0.4.0. Older APIs ignore the new SQL keys (`orm`, `database`, `sql`,
  `errors`, `errorCodes`, `histFine`, `sampleRate`).
- Prisma 7 statements through an adapter whose driver is not `pg` are not
  captured (`@prisma/adapter-neon`, `@prisma/adapter-ppg` and others). The
  supported path is `@prisma/adapter-pg`, including its private `pg` copy.
- On Node 20/22, Prisma 7 statements are labelled from the SQL (table and
  verb), not the Prisma model and method. Node 24 and later get the Prisma
  labels.
- On Prisma 5/6 with the adapter, `count()` is labelled with model `(sql)`,
  because its table is inside a subquery.
- Prisma 7: the SDK's own tracing helper always reports itself disabled, so it
  never adds headers to Prisma Accelerate requests (Accelerate statements are
  not visible) and Prisma never adds trace context because of it.

### Cost of PostgreSQL capture

The SDK times every `pg` query, so it adds a small fixed cost to each one.
Across two runs we measured about 1–1.6 µs per `pg` query, about 2–3 µs per
Prisma 7.10 call, about 6 µs per Prisma 6.19 call, and no measurable
difference on Prisma 5.22. That is against a local database round trip of
about 35 µs; against a networked database (typically 0.5 ms or more per round
trip) it is a small fraction. `sql.sampleRate` below 1 saves little (under
1 µs for `pg`), because every call is still timed.

Measured on an Apple M4 with Node 26.7.0 and a local Postgres, modes
interleaved, median of 6 rounds, µs per operation (one of the two runs):

| stack | SDK off (µs/op) | SDK, sampleRate 1 (µs/op) | SDK, sampleRate 0.1 (µs/op) |
|---|---|---|---|
| pg 8.23 `pool.query` by id | 33.9 | 35.5 | 34.6 |
| Prisma 7.10 `findUnique` | 64.0 | 65.8 | 65.6 |
| Prisma 6.19 `findUnique` | 113.7 | 119.5 | 117.2 |
| Prisma 5.22 `findUnique` | 114.6 | 115.2 | 114.7 |

### Deploying the 0.4.0 API

- The API now rejects `thresholdMs` above 3,600,000 (one hour) with a 400. An
  0.3.x SDK configured above that will see every batch rejected; 0.4.0 clamps
  it. Lower the setting before deploying.
- The API rejects a batch whose `bucket` is malformed or outside the last 48
  hours to the next hour (server UTC). SDKs always send the current hour, so a
  rejection means a badly wrong client clock.
- The `20261101220000_sql_postgres` migration takes a short exclusive lock on
  `QueryRollup`. Deploy at a quiet time, or set `lock_timeout` for the deploy
  session and retry on timeout.

## 0.3.0

- Capture moved from Mongoose middleware to the driver's command monitoring. It
  covers Mongoose 6-9, Mongoose 5.13 (best effort, needs `monitorCommands: true`)
  and the raw `mongodb` driver 4-7. New: `init({ mongoClient })` and
  `instrument(client)`.
- 0.2 threw `TypeError: next is not a function` into app code on Mongoose 9.
  0.3 does not.
- **0.3 measures database time.** 0.2 also counted time in the app (casting,
  hydration, pool waits, `bufferCommands`), so latencies for the same query shape
  can drop at the upgrade. Durations are still whole milliseconds.
- All 35 tested Mongoose 8 query shapes keep their 0.2 hash, filter shape and
  sample. Discriminator aggregates keep their 0.2 model name (the
  discriminator). Known exception, by design: two base models sharing one
  collection both resolve to the first registered. Database-level aggregates
  (`aggregate: 1`, such as `db.watch()` or `$documents`) belong to no
  collection and are not captured. Newly captured: `insert` (no sample), `save()`, `bulkWrite` statements,
  `Model.collection.*`, failed commands, and `estimatedDocumentCount` (shown as
  `count`).
- Call `init()` before connecting. Otherwise connect with
  `monitorCommands: true`; the SDK warns once when monitoring is off,
  including for a client connected before `init()` (then after its first few
  commands).
- Items now carry `source` and `collection`. Older APIs ignore them; the
  dashboard uses `collection` for the Compass command.
- Known limitation: an app that loads both the CJS and ESM copies of the SDK and
  calls `init()` in both can lose zero-setup capture for clients that connect
  later. Call `init()` from one module system.

### Cost of turning monitoring on

The driver builds each command reply for its monitoring event, and there is no
opt-out. For small operations (`findOne`, `insertOne`) we saw no measurable
difference. For a large read, `find()` of 20,000 documents with `toArray()`, the
cost was about 31-43% on drivers 6 and 7. That cost comes from the driver's own
command monitoring, not from the SDK: monitoring-only cost is about the same as
the SDK's cost.

One run on one machine, measuring listener cost only (no operation crossed the
threshold). Median of 5 runs after a warm-up, 20,000 seeded documents:

| driver | workload | monitoring off (ms/op) | monitoring only (ms/op) | SDK (ms/op) | SDK added |
|---|---|---|---|---|---|
| mongodb 6 | find 20k docs, toArray | 13.78 | 19.77 | 19.66 | 42.7% |
| mongodb 7 | find 20k docs, toArray | 16.33 | 21.21 | 21.34 | 30.7% |
