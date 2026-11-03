# @vivekumar08/query-analyser

Find your slow MongoDB and PostgreSQL queries. One line of setup.

```bash
npm install @vivekumar08/query-analyser
```

```js
require('@vivekumar08/query-analyser').init({
  apiKey: process.env.QA_KEY,
  app: 'my-service',
});
```

That is the whole setup. Every MongoDB command at 100 ms or slower, and every
PostgreSQL statement, is grouped by its *shape*, aggregated in memory, and
shipped to your dashboard every ten seconds.

Call `init()` before your app connects to MongoDB (before `mongoose.connect()`
or `client.connect()`). The SDK listens to the driver's own command events, so
it works with Mongoose and with the plain `mongodb` driver. For PostgreSQL
through `pg` or Prisma, see [PostgreSQL: pg and Prisma](#postgresql-pg-and-prisma).

## Using the mongodb driver

When `init()` runs first there is nothing to add: clients that connect later are
captured automatically.

For a client created earlier, or from a bundled copy of the driver the SDK
cannot resolve, connect it with `{ monitorCommands: true }` and either pass it to
`init()` or call `instrument(client)`:

```js
const { MongoClient } = require('mongodb');
const qa = require('@vivekumar08/query-analyser');

const client = new MongoClient(uri, { monitorCommands: true });
qa.init({ apiKey: process.env.QA_KEY, app: 'my-service', mongoClient: client });
// or, for lazily created clients and serverless handlers:
qa.instrument(client);
await client.connect();
```

`instrument(client)` is safe to call on every invocation with one cached client:
it attaches one set of listeners. Calling `init({ mongoClient })` again is fine
too.

If monitoring is off for a client the SDK warns once:

```
query-analyser: command monitoring is off for a MongoClient, so if this client was already connected its queries are not captured. Pass `monitorCommands: true` in its connect options, or call init() before connecting.
```

Do what it says: pass `monitorCommands: true` in the connect options, or call
`init()` before connecting. For a client that was already connected when the SDK
first saw it, the warning can come after its first few commands instead of
straight away.

## PostgreSQL: pg and Prisma

**`pg` and Prisma 7:** nothing to add beyond `init()`. The SDK wraps `pg`'s
`Client.prototype`, so clients and pools created before `init()` are covered
too. Prisma 7 always runs its SQL through a driver adapter; with
`@prisma/adapter-pg` that is `pg`, including the adapter's own private copy of
`pg`, which the SDK finds by itself.

**Prisma 5.22 and 6.x:** use `@prisma/adapter-pg`. Prisma 5.22 and 6.0 also
need `previewFeatures = ["driverAdapters"]` in the `generator` block (and a
`prisma generate`); 6.19 does not.

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"] // needed on 5.22.0 and 6.0.1; not on 6.19.3
}
```

```js
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString })) });
```

**Without the adapter (Prisma 5/6 engine path),** queries run inside Prisma's
query engine, not in JavaScript. The SDK captures them only when your app
already enables Prisma tracing itself, for example with its own
`@prisma/instrumentation`. The SDK never turns tracing on and never adds
`traceparent` comments, so the SQL your database receives is exactly what
your app sends.

When `@prisma/client` 5.x or 6.x resolves, `@prisma/adapter-pg` does not, and
your app has no Prisma tracing, the SDK warns once at `init()`:

```
query-analyser: @prisma/client 6.19.3 without @prisma/adapter-pg runs its SQL inside the query engine, which the SDK captures only when your app already enables Prisma tracing. Use @prisma/adapter-pg, or Prisma 7, to capture these queries.
```

Do what it says: switch to `@prisma/adapter-pg` (above), or upgrade to Prisma 7.
Prisma tracing has a per-query cost of its own, so turn it on only if you want
it for your own tracing, not just for the SDK.

**A bundled `pg` the SDK cannot resolve** (for example one inlined by a
bundler): pass the module, or instrument a pool or client directly:

```js
const pg = require('pg');
qa.init({ apiKey: process.env.QA_KEY, app: 'my-service', pg });
// or
qa.instrument(pool); // a pg Pool or Client; its class is wrapped once
```

### What is timed

Each statement's round trip, from `query()` to its result. That includes the
time it waits in the client's own queue, and excludes pool checkout (waiting
for a free connection). Durations are fractional milliseconds.

### What is counted

- **Every SQL statement** is counted: its count, total time, errors and a fine
  latency histogram. `thresholdMs` (default 100) defines "slow": only
  statements at or over it count as slow queries.
- **`sql.sampleRate`** (default `1`, must be `> 0` and `<= 1`) times only that
  fraction of fast, successful statements and weights each kept one by
  `1 / rate`. Slow statements and failures are never sampled, so slow counts
  and error counts stay exact. The dashboard marks figures that include sampled
  data as **"estimated (sampled at N%)"**.

  ```js
  qa.init({ apiKey: process.env.QA_KEY, app: 'my-service', sql: { sampleRate: 0.1 } });
  ```
- **MongoDB stays slow-only:** its counts mean "queries at or over
  `thresholdMs`", and they are never added to SQL counts.

### Masking

`sql: { maskIdentifiers: true }` replaces table, column, schema, alias, model
and database names with `t_` plus 16 hex characters of an HMAC keyed from your
API key, before anything leaves your process. Keywords, well-known functions
and cast types stay readable. This hides names; it is **not encryption**.
Turning it on (or rotating the API key while it is on) changes every
fingerprint, so those queries start new history.

### Known limitations

- A Prisma upgrade, including a 6.x minor, can change the SQL Prisma generates
  and so start new history for some queries.
- Identical SQL from two Prisma methods carries the first label it was seen
  with, so the ORM and Operation filters can under-report.
- `$transaction([...])` and batched calls carry the first operation's label.
- On Prisma 5/6 with the adapter, the model comes from the SQL table and the
  operation from the SQL verb, and the `prisma` label is inferred from the
  adapter's call shape. `count()` is labelled with model `(sql)`, because its
  table is inside a subquery.
- On Node 20/22, Prisma 7 statements are labelled from the SQL (table and
  verb), not the Prisma model and method. Reading Prisma's labels there would
  slow every `await` in your app; Node 24 and later carry them at no such cost
  (unless started with `--no-async-context-frame`).
- With your own Prisma tracing, labels (adapter path) or statements (engine
  path) cover only the operations your sampler keeps.
- On the engine path, failed statements are not counted as errors.
- The same SQL on two databases is one row, showing the first database.
- `pg-native`, `pg-cursor` and `pg-query-stream` are not timed.
- On Prisma 7, statements through an adapter whose driver is not `pg` are not
  captured: for example `@prisma/adapter-neon`, `@prisma/adapter-ppg` or
  another non-`pg` driver. The supported path is `@prisma/adapter-pg`
  (including its private `pg` copy); a bundled `pg` the SDK cannot resolve
  needs `init({ pg })` or `instrument(pool)`.
- Prisma Accelerate (`prisma://`) is not visible. The SDK changes nothing about
  those requests and adds no headers to them.

## Supported versions

| Library | Status |
|---|---|
| `mongodb` driver 4, 5, 6, 7 | supported and tested |
| Mongoose 6, 7, 8, 9 | supported and tested |
| Mongoose 5.13 (driver 3.7) | best effort; **requires** `monitorCommands: true` in the connect options, because the SDK cannot switch monitoring on or detect it there |
| `pg` `>=8.0 <9` | supported and tested (8.0.3 to 8.23.1) |
| Prisma 7.x | supported and tested (7.10.1), with `@prisma/adapter-pg` |
| Prisma 6.x | supported and tested (6.0.1 and 6.19.3), with `@prisma/adapter-pg`, or on the engine path with your app's own Prisma tracing |
| Prisma 5.22 | supported and tested (5.22.0), with `@prisma/adapter-pg`, or on the engine path with your app's own Prisma tracing |
| Prisma 8 | not supported |

## Migrating from 0.2

- Mongoose 8 users whose `init()` runs before connecting have nothing to do.
  Otherwise add `monitorCommands: true` to the connection options (the SDK warns
  once if it is missing).
- Mongoose 9: 0.2 threw `TypeError: next is not a function` into app code. 0.3
  does not.
- All 35 tested Mongoose 8 query shapes keep their 0.2 hash, filter shape and
  sample (a golden test checks each one), so their history continues.
  Discriminator aggregates are still named after the discriminator model, as
  in 0.2. One known exception, by design: when two base models (not
  discriminators) share one collection, every query on it is named after the
  first one registered.
- 0.3 measures database time. 0.2 also counted time spent in the app (casting,
  hydration, pool waits, `bufferCommands`), so latencies for the same shape can
  drop at the upgrade. Durations are whole milliseconds.
- Newly captured: `insert`, `save()`, `bulkWrite` statements,
  `Model.collection.*`, failed commands, and `estimatedDocumentCount` (which
  appears as `count`). `insert` items carry no sample.

## What leaves your process

For MongoDB: key names, operator classes, durations, counts. That is all. (For
PostgreSQL, see [below](#postgresql).)

A query like `Order.find({ email: 'someone@example.com', total: { $gte: 500 } })`
is reported as:

```
Order.find(email:eq,total:range)
```

with a type-only sample: `{"filter":{"email":"<string>","total":{"$gte":"<number>"}}}`.
`update` and `sort` are included in the sample only when the query actually
has one — a plain `find()` with no sort reports as
`{"filter":{...}}`, not `{"filter":{...},"update":"<undefined>","sort":"<undefined>"}`.
Each item also carries `source` (`mongodb`) and `collection` (the collection
name).
**By default, no queried value ever leaves your process.** The only exception is
the opt-in `sampleKey` below, and even then the values are encrypted before they
leave, so we cannot read them.

Object *key* names are transmitted by design — they are what the index advice
is computed from, and this applies to any object key in a filter, update or
sort, at any depth, not just the top-level filter keys. If you build a key out
of user-controlled data anywhere in one of those three — a filter key like
`{ ['email_' + userInput]: 1 }`, or an update like `{ $set: { [userKey]: 1 } }`
— that data becomes a key name and does leave your process. Do not put
sensitive values in filter, update, or sort keys.

### PostgreSQL

A statement like `SELECT * FROM "User" WHERE email = $1 AND total >= 500` is
reported as `SELECT * FROM "User" WHERE email = ? AND total >= ?`. Every
literal, `$n` parameter, comment and dollar-quoted body becomes `?` or is
dropped before anything is buffered. SQL items carry `sample: null` and never an
encrypted sample: with `sampleKey` set they carry `encryptedSample: null`.

Every SQL item has the same keys as a MongoDB item: `signature` (the
normalized SQL, truncated to 400 characters), `hash`, `model`, `operation`,
`filterShape`, `sortKeys` and `stages` (always `[]` for SQL), `count`,
`totalMs`, `maxMs`, `lastMs`, `lastTs` (a timestamp), `hist`, `sample`,
`source` (`"postgresql"`) and `collection` (the table). It may also carry:

| Key | Meaning |
|---|---|
| `orm` | `"prisma"`; absent for plain `pg` |
| `database` | the database name the statement ran on |
| `sql` | the full normalized SQL, values removed |
| `errors` | failed executions in this window |
| `errorCodes` | the most frequent SQLSTATE codes (such as `23505`) with counts |
| `histFine` | a finer latency histogram over all statements |
| `sampleRate` | present only when `sql.sampleRate` is below 1 |

**Parameter values, query results, error messages and connection strings
never leave your process.** The SDK reads only the SQL text, the client's
database name and an error's SQLSTATE code. Table, column and database names
do leave, unless you turn on `sql.maskIdentifiers` (see
[Masking](#masking)).

## Real-value samples (opt-in, end-to-end encrypted)

To paste the *exact* slow query into MongoDB Compass, turn on sample encryption
for the app in the dashboard (Settings) and pass the public key it shows you:

```js
require('@vivekumar08/query-analyser').init({
  apiKey: process.env.QA_KEY,
  app: 'my-service',
  sampleKey: process.env.QA_SAMPLE_KEY,
});
```

- The slowest occurrence of each query shape is serialised (at most 16 KiB; larger
  samples are skipped) and **encrypted on your server** to that public key before
  it is sent.
- Memory stays bounded: at most about 16 KiB of sample text per tracked shape,
  for up to `maxSignatures` shapes, held until the next flush.
- Only someone with your team's passphrase can decrypt it, in the browser. We
  store only ciphertext and **cannot read your values**.
- Without `sampleKey` (or with an empty one) nothing changes: payloads are exactly
  as described above. An invalid key is reported once through `onError` and the
  SDK carries on without samples.

## Options

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | — | required; your app's ingest key |
| `app` | — | required; names the app in the dashboard |
| `thresholdMs` | `100` | "slow": MongoDB queries at or over it are recorded; every SQL statement is counted, and those at or over it count as slow |
| `flushIntervalMs` | `10000` | how often a batch is sent |
| `maxSignatures` | `5000` | cap on distinct shapes held between flushes |
| `env` | `NODE_ENV` | separates production from staging in the dashboard |
| `enabled` | `true` | set `false` to make `init` a no-op |
| `endpoint` | hosted ingest | override for self-hosted |
| `mongoose` | auto-resolved | pass explicitly if resolution fails |
| `mongoClient` | — | a `MongoClient` (or an array) to capture explicitly; needs `monitorCommands: true` unless `init()` ran before connecting |
| `onError` | logs to stderr | called with internal errors |
| `sampleKey` | — | opt-in: app's sample public key; sends end-to-end encrypted real-value samples (MongoDB only) |
| `pg` | auto-resolved | the `pg` module, for a bundled copy the SDK cannot resolve; the app's own `pg` and `@prisma/adapter-pg`'s copy are found without it |
| `sql.sampleRate` | `1` | fraction (`> 0`, `<= 1`) of fast, successful SQL statements to time; slow and failed ones are always counted. An invalid value is reported once and treated as `1` |
| `sql.maskIdentifiers` | `false` | replace table, column, schema and database names with keyed hashes before they leave the process |

## Notes

- Call `init()` before connecting. The SDK listens to the driver's command
  events; it adds no code of its own to your queries (plus, with `sampleKey`, a
  bounded 16 KiB serialisation when a query is the new slowest for its shape;
  encryption happens later, at flush). No I/O on the query path. Turning on the
  driver's command monitoring has a cost for very large reads; see the
  [changelog](./CHANGELOG.md).
- For `pg` and Prisma the SDK wraps `pg`'s `query()` and times it. On an Apple
  M4 with a local Postgres we measured about 4 µs per `pg` query and about
  2–3 µs per Prisma call; see the [changelog](./CHANGELOG.md).
- Known limitation: an app that loads both the CommonJS and ESM copies of the SDK
  and calls `init()` in both can lose zero-setup capture for clients that connect
  later. Call `init()` from one module system.
- If the endpoint is unreachable the SDK retries with backoff and then drops.
  Your queries are never affected.
- `await require('@vivekumar08/query-analyser').shutdown()` drains the buffer
  before exit. `beforeExit` does this for you when the event loop empties. For a
  graceful shutdown on SIGTERM, call it from your own handler — the SDK never
  registers signal handlers, because that would change how your process exits:

  ```js
  process.on('SIGTERM', async () => {
    await require('@vivekumar08/query-analyser').shutdown();
    server.close(() => process.exit(0));
  });
  ```

MIT
