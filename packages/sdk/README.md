# @vivekumar08/query-analyser

Find your slow MongoDB queries. One line of setup.

```bash
npm install @vivekumar08/query-analyser
```

```js
require('@vivekumar08/query-analyser').init({
  apiKey: process.env.QA_KEY,
  app: 'my-service',
});
```

That is the whole setup. Every MongoDB command at 100 ms or slower is grouped by
its *shape*, aggregated in memory, and shipped to your dashboard every ten
seconds.

Call `init()` before your app connects to MongoDB (before `mongoose.connect()`
or `client.connect()`). The SDK listens to the driver's own command events, so
it works with Mongoose and with the plain `mongodb` driver.

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
`init()` before connecting.

## Supported versions

| Library | Status |
|---|---|
| `mongodb` driver 4, 5, 6, 7 | supported and tested |
| Mongoose 6, 7, 8, 9 | supported and tested |
| Mongoose 5.13 (driver 3.7) | best effort; **requires** `monitorCommands: true` in the connect options, because the SDK cannot switch monitoring on or detect it there |

## Migrating from 0.2

- Mongoose 8 users whose `init()` runs before connecting have nothing to do.
  Otherwise add `monitorCommands: true` to the connection options (the SDK warns
  once if it is missing).
- Mongoose 9: 0.2 threw `TypeError: next is not a function` into app code. 0.3
  does not.
- Query hashes for the same query shape are unchanged between 0.2 and 0.3 (a
  35-case golden test proves it), so your history continues.
- 0.3 measures database time. 0.2 also counted time spent in the app (casting,
  hydration, pool waits, `bufferCommands`), so latencies for the same shape can
  drop at the upgrade. Durations are whole milliseconds.
- Newly captured: `insert`, `save()`, `bulkWrite` statements,
  `Model.collection.*`, failed commands, and `estimatedDocumentCount` (which
  appears as `count`). `insert` items carry no sample.

## What leaves your process

Key names, operator classes, durations, counts. That is all.

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
| `thresholdMs` | `100` | only queries at 100 ms or slower are recorded |
| `flushIntervalMs` | `10000` | how often a batch is sent |
| `maxSignatures` | `5000` | cap on distinct shapes held between flushes |
| `env` | `NODE_ENV` | separates production from staging in the dashboard |
| `enabled` | `true` | set `false` to make `init` a no-op |
| `endpoint` | hosted ingest | override for self-hosted |
| `mongoose` | auto-resolved | pass explicitly if resolution fails |
| `mongoClient` | — | a `MongoClient` (or an array) to capture explicitly; needs `monitorCommands: true` unless `init()` ran before connecting |
| `onError` | logs to stderr | called with internal errors |
| `sampleKey` | — | opt-in: app's sample public key; sends end-to-end encrypted real-value samples |

## Notes

- Call `init()` before connecting. The SDK listens to the driver's command
  events; it adds no code of its own to your queries (plus, with `sampleKey`, a
  bounded 16 KiB serialisation when a query is the new slowest for its shape;
  encryption happens later, at flush). No I/O on the query path. Turning on the
  driver's command monitoring has a cost for very large reads; see the
  [changelog](./CHANGELOG.md).
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
