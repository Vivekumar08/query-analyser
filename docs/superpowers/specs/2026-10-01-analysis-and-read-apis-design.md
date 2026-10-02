# Analysis and read APIs

Date: 2026-10-01
Repo: `query-analyser` (`apps/api`)
Implements: §7 of `2026-09-20-query-analyser-design.md`, plus the read routes in §5
Phase: 4 of the spec's delivery order

Phases 1–3 are complete and verified in production: the SDK and contract are
published, `POST /v1/ingest` accepts batches, and auth, RBAC, orgs, apps, keys,
invites and the platform-admin surface all ship. Rollups are accumulating. This
phase turns them into answers.

## What is already in place

The schema needs no new tables. `QueryRollup`, `QueryDailyRollup`, `Alert` and
`Advice` all exist with the right shapes and indexes, and `hist` is a fixed
8-element `Int[]` with a CHECK constraint on both rollup tables.

Retention is settled by §6: hourly rollups are kept 7 days, compacted nightly
into daily rollups kept 90 days.

Histogram bounds come from the contract's `HIST_BOUNDS`:

```
[0,100) [100,250) [250,500) [500,1000) [1000,2500) [2500,5000) [5000,10000) [10000,∞)
```

The top bucket is unbounded. That single fact drives the percentile design.

## Shape of the work

A new `apps/api/src/analysis/` module, one responsibility per file, mirroring
how `ingest/` is laid out:

| File | Kind | Exports |
|---|---|---|
| `percentile.ts` | pure | `percentileFromHist(hist, maxMs, p)` |
| `regression.ts` | pure | `detectRegression(trailing, latest)` |
| `advice.ts` | pure | `adviceFor(filterShape, sortKeys)` |
| `compaction.ts` | SQL | `compactDay`, `pruneHourly`, `pruneDaily` |
| `jobs.ts` | orchestration | `runHourlyJobs(deps)`, `runNightlyJobs(deps)` |
| `scheduler.ts` | plugin | owns only *when* jobs fire |
| `routes.ts` | HTTP | the seven read endpoints |

Bulk row work is set-based SQL because it grows with the customer base.
Arithmetic is pure TypeScript because every arithmetic bug this project has
caught — the `toFixed` half-cent, the session-timezone bucket shift, the
unclamped discount — was caught by a unit test on a pure function.

## Scheduling

`scheduler.ts` is a Fastify plugin whose timers start only when `buildApp`
receives `startScheduler: true`. `server.ts` passes it; tests never do. The 114
existing tests must not each spawn background timers, and the jobs are better
tested by calling them directly.

Two schedules:

- **Hourly, at :05** — `runHourlyJobs`: regression detection over the last
  complete hour.
- **Nightly** — `runNightlyJobs`: compact hourly into daily, detect new
  expensive signatures, refresh advice, then prune.

### The queue seam

`runHourlyJobs` and `runNightlyJobs` are plain async functions taking their
dependencies as an argument. They know nothing about timers, locks or Fastify.
Scaling out means writing a BullMQ worker that calls these two functions and
deleting the adapter — the analysis code does not change.

Until then, every tick takes `pg_try_advisory_lock` before doing anything and
releases after; a tick that cannot take the lock returns immediately. On one
replica this is belt-and-braces. On two it is the difference between correct
and double-counted, and the api-foundation review already flagged that every
piece of shared state in this service is per-replica.

**The advisory lock is a placeholder for the queue.** When BullMQ lands, job
IDs give the same guarantee and the lock should be removed rather than kept.

## Percentiles

```
percentileFromHist(hist: number[], maxMs: number, p: number)
  → { value: number, basis: 'interpolated' | 'floor' }
```

Find the bucket containing the target rank, then interpolate linearly between
that bucket's bounds. If the rank falls in the unbounded top bucket there is
nothing to interpolate toward, so the function returns `maxMs` — a real
observed value — with `basis: 'floor'`.

`basis` reaches the API response. §7 requires the UI to label the number `p95 ≈`;
returning the basis makes that a property of the data rather than a convention
someone has to remember, and lets the dashboard distinguish `p95 ≈ 1,240ms`
from `p95 ≥ 14,002ms`.

`avgMs` is `totalMs / count`, computed in TypeScript after the BigInt is
converted, not in SQL.

## Regression detection

```
detectRegression(trailing: HourPoint[], latest: HourPoint) → Alert | null
```

Pure. Fires when `latest.p95 > REGRESSION_FACTOR × median(trailing p95s)` and
`latest.count >= MIN_COUNT`, with `REGRESSION_FACTOR = 2` and `MIN_COUNT = 20`
as named constants. The count floor exists because one cold query at 3 a.m. is
not a regression.

**Job ordering is load-bearing.** Hourly rollups are kept 7 days and the rule
needs a 7-day trailing median — exactly equal, so the window always sits at the
retention edge. Pruning must run *after* detection within `runNightlyJobs`, or
the rule silently loses its oldest hour. This ordering gets its own test.

### New expensive signatures

A signature first seen within 24 hours whose total wasted time is in the top ten
for its app raises a `new_expensive` alert. A pure-regression rule misses these
entirely — there is no baseline to regress from — and a deploy introducing a bad
query is the most common real cause.

## Index advice

```
adviceFor(filterShape, sortKeys) → { suggestion, rationale } | null
```

Equality–Sort–Range: equality-matched fields first, then sort fields in their
sort order, then range-matched fields. Fields classified `regex`, `ne` or
`other` are excluded from the key and named in the rationale as unindexable in
that position.

Returns `null` — no advice row written at all — when the filter is only `_id`,
when the shape is empty, or when existing advice for that signature is already
`DISMISSED`.

The rationale states that this is a heuristic derived from query shape, not a
verified plan: the service has never seen the customer's indexes or collection
statistics.

## Compaction

`compactDay` recomputes a whole day from the hourly rows that still exist and
**overwrites** the daily row. It does not accumulate.

This is the one decision most likely to be got wrong later. `ON CONFLICT DO
UPDATE SET count = count + EXCLUDED.count` reads naturally and doubles a day's
numbers the first time the nightly job runs twice — a retry, a restart
mid-run, a manual trigger. Replace semantics make a re-run a no-op, and an
idempotency test pins it.

Element-wise `hist` summation reuses the `unnest` pattern already in
`ingest/writer.ts`, proven order-deterministic by direct psql test during the
api-foundation plan. No new arithmetic is invented for it.

Pruning runs only after the day is written.

## Read APIs

All seven sit behind `requireAppRole`, inheriting its 404-not-403 posture and
its suspended-org block.

```
GET   /v1/apps/:id/queries?from&to&sort&model&op&limit   VIEWER+
GET   /v1/apps/:id/queries/:sig                          VIEWER+
GET   /v1/apps/:id/queries/:sig/series?from&to           VIEWER+
GET   /v1/apps/:id/alerts                                VIEWER+
PATCH /v1/apps/:id/alerts/:alertId                       MEMBER+
GET   /v1/apps/:id/advice                                VIEWER+
PATCH /v1/apps/:id/advice/:adviceId                      MEMBER+
```

Reads at VIEWER, state changes at MEMBER. Acknowledging an alert and marking
advice applied are workflow acts, not observation. §5's route table does not
say, so this spec chooses rather than leaving it implicit.

**The window picks its own grain.** `from`/`to` spanning 7 days or less reads
hourly rollups; longer spans read daily. The caller does not choose, because
retention means the choice is not free — 30 days of hourly data does not exist.
Every response states which grain answered it.

**Ranking** is by wasted time (`sum(totalMs)`) by default, with
`sort=count|p95|maxMs`. `limit` defaults to 50 and caps at 200. The
api-foundation review flagged an unbounded `findMany` on the admin surface as a
deferred minor; this phase does not add a second one.

**`totalMs` is a string in every response.** It is a `BigInt` and the app
installs a BigInt-safe JSON serializer. `avgMs` and the percentiles are numbers.
Consumers must convert before arithmetic.

`GET /v1/apps/:id/queries/:sig` returns the signature, its histogram, the
redacted sample, and current advice if any.

## Testing

Unit, on the pure helpers:

- `percentileFromHist` — empty histogram, rank in bucket 0, rank in the
  unbounded top bucket returning `basis: 'floor'`, a rank on an exact bucket
  boundary.
- `detectRegression` — exactly `2×` the median, just over, count exactly 20,
  count 19, an empty trailing window.
- `adviceFor` — each excluded op class, `_id`-only filter, empty shape, a
  sort-and-range combination proving Equality–Sort–Range ordering.

Integration:

- **Compaction idempotency** — run `compactDay` twice, assert the daily row is
  identical. This is what catches a slide back to accumulate semantics.
- **Job ordering** — `runNightlyJobs` must detect before it prunes.
- **Grain selection** — a 3-day window reads hourly, a 30-day window reads
  daily.

Route tests:

- Every endpoint gets an auth test that **fails when its gate is removed**. A
  gate implemented correctly but pinned by no test was the main finding in three
  consecutive tasks of the previous plan; this is a requirement, not a hope.
- `PATCH` on alerts and advice refuses VIEWER.

## Out of scope

- The driver-level SDK adapter for non-Mongoose projects — its own spec, agreed
  to follow this phase.
- Moving `app.ingestStats` from in-process counters to a table.
- `GET /v1/admin/offenders` from §5's route table.
- The dashboard (phases 5–6). This phase ships the API it will consume.
- Email or Slack delivery of alerts. §7 puts it out of v1.

## Build order

1. `percentile.ts` with its tests — everything else reads percentiles.
2. `compaction.ts` plus the idempotency test.
3. `regression.ts`, `advice.ts`, and `jobs.ts` wiring them together with the
   detect-before-prune ordering.
4. `scheduler.ts` and the `startScheduler` flag.
5. The seven read endpoints.
