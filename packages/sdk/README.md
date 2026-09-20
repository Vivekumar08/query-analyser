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

That is the whole setup. Every mongoose query at 100 ms or slower is grouped by
its *shape*, aggregated in memory, and shipped to your dashboard every ten
seconds.

Requires `mongoose` `>=8 <9` as a peer dependency. The pre-compiled-model
instrumentation relies on undocumented mongoose internals that are verified
only against mongoose 8; other majors are not supported.

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
**No queried value ever leaves your process.** There is no option to turn that off.

Object *key* names are transmitted by design — they are what the index advice
is computed from, and this applies to any object key in a filter, update or
sort, at any depth, not just the top-level filter keys. If you build a key out
of user-controlled data anywhere in one of those three — a filter key like
`{ ['email_' + userInput]: 1 }`, or an update like `{ $set: { [userKey]: 1 } }`
— that data becomes a key name and does leave your process. Do not put
sensitive values in filter, update, or sort keys.

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
| `onError` | logs to stderr | called with internal errors |

## Notes

- Call `init()` anywhere. Models compiled before the call are instrumented too.
- Nothing runs on the query path except a timestamp and a map write. No I/O.
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
