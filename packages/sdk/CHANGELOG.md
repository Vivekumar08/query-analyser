# Changelog

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
  sample. Newly captured: `insert` (no sample), `save()`, `bulkWrite` statements,
  `Model.collection.*`, failed commands, and `estimatedDocumentCount` (shown as
  `count`).
- Call `init()` before connecting. Otherwise connect with
  `monitorCommands: true`; the SDK warns once when monitoring is off.
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
