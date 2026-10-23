# MongoDB driver monitoring: every Mongoose version, and raw-driver apps

Date: 2026-10-23
Repo: `query-analyser` (`packages/sdk`, `packages/contract`, `apps/api`, a small part of `apps/web`). Builds on `main` at `fd9bdb9` (#14).
Roadmap: this is project 1 of 4. Project 2 adds Prisma and SQL databases, project 3 is the dashboard redesign, and project 4 is an MCP server. The user set the order: 1, then 2, then 4.

## Why

The user's goal is reach: "I want to provide the availability to most of the devs". Today the SDK works only for Mongoose 8 (`peerDependencies: mongoose >=8 <9`). So it misses:
- apps on Mongoose 6 and 7;
- Mongoose 9;
- every app that uses the official `mongodb` driver without Mongoose, which is common in Next.js and serverless code.

Today's hook is also fragile. It uses Mongoose schema middleware, and for models compiled before `init()` it patches them through undocumented internals (`model._applyQueryMiddleware()`, `schema.s.hooks.clone()`, `packages/sdk/src/index.ts:80-86, 457-470`). The comment there says those internals were checked only on 8.24.4.

## The decision (proposed by the controller, accepted by the user)

Listen at the **MongoDB driver** level with the driver's built-in command monitoring (`commandStarted`, `commandSucceeded`, `commandFailed`) and stop using Mongoose middleware as the hook. Every Mongoose version runs on the driver, so one layer covers Mongoose apps and raw-driver apps.

What this buys:
- **Coverage:** `insert`, `bulkWrite` (it reaches the driver as insert/update/delete commands), `findAndModify`, `count`, `distinct`, operations on `Model.collection`, and **failed commands**, none of which are captured today.
- **Timing:** the driver's own `duration` per command, instead of the `Date.now()` difference with its 1 ms resolution.
- **Robustness:** the undocumented-internals patching and the `next()`-style middleware go away.

**Model names without internals:** a driver event carries the database and collection name, not the Mongoose model. When Mongoose is present, the SDK builds a map from `(db name, collection name)` to model name out of the public registry (each connection's `models`, `model.collection.collectionName`, `model.db.name`) and uses the model name. The map is rebuilt lazily when a lookup misses, because models are added after `init()`. With no Mongoose, or when no model matches, the collection name is used. So a raw-driver app shows `orders.find` and a Mongoose app still shows `Order.find`.

## Developer-facing API

- **Mongoose apps: no change.** `init({ apiKey, app })` keeps working. The SDK finds Mongoose the way it does now (`resolveMongoose`, or `init({ mongoose })`) and attaches to the driver client of every connection: the existing ones, and ones opened later (`mongoose.connections` plus the connection events).
- **Raw-driver apps:** `init({ apiKey, app, mongoClient })`. `mongoClient` takes one `MongoClient` or an array of them. A client can also be added after `init()` through a new exported function, `instrument(client)`, for apps that create the client lazily, which is common in serverless code. The name `instrument` is the controller's call; the builder may rename it before the release.
- **Both together:** allowed. One client is never instrumented twice: the guard is a symbol on the client, like today's `Symbol.for('query-analyser.plugin-registered')`.
- The public API stays small: `init`, `shutdown`, `instrument`, `SDK_VERSION` and the types. Existing `InitOptions` fields keep their meaning.
- **One open question for the spike:** can monitoring be switched on for a client that is **already connected**? On driver 4 and later, the controller believes `MongoClient` exposes a `monitorCommands` setter. If that is false for some supported version, the fallback is a documented one-line setup for those versions: `monitorCommands: true` in the connect options. In that case the SDK logs a single warning that names the setting when it attaches to a client whose monitoring is off. It must not silently capture nothing.

## What is captured

| Driver command | Operation name shown | Shape source |
|---|---|---|
| `find` | `find` (`findOne` cannot be told apart at driver level; see Anti-goals) | `filter`, `sort` |
| `aggregate` | `aggregate` | `pipeline` stage names, as today |
| `update` (each statement) | `update` | `q` as filter, `u` as the update sample |
| `delete` (each statement) | `delete` | `q` |
| `insert` | `insert` | no filter shape |
| `findAndModify` | `findAndModify` | `query`, `sort` |
| `count`, `distinct` | same name | `query` |
| `getMore` | not its own signature: its duration is added to the cursor's originating command when the SDK can match it by cursor id, otherwise dropped | n/a |

- **Ignored:** handshake, auth and topology commands (`hello`, `isMaster`, `ping`, `saslStart`, `saslContinue`, `buildInfo`, `endSessions`, …), and anything run against the `admin`, `local` or `config` databases. The ignore list is an allow-list of the commands above, not a deny-list, so unknown new commands are ignored by default.
- **Threshold (controller's call C3):** a command counts when its own driver `duration` is at least `thresholdMs` (default 100). The first command decides. When it counts, the durations of `getMore`s matched to its cursor are added to its time. A slow `getMore` on a cursor whose first command was fast is counted on its own, under the originating signature. This avoids holding events until cursors close.
  - **What changes for users:** 0.3 measures **database time**. 0.2 also included time spent in the app (casting, hydration, waiting for a pool connection, `bufferCommands`). Latencies for the same shape can drop at the upgrade. The release notes say so plainly, and the dashboard needs no change.
- **Failures:** a failed command at or over the threshold is counted in the same signature, with the same rollups. Recording the failure *reason* (the error code) is out of scope and noted for later.
- **Matching start to end:** by `requestId` (plus `connectionId`). Starts that never end are kept in a bounded map, with a maximum size and age; the builder picks the values. They must never grow without limit.
- **Operation names are rebuilt Mongoose-style from the command (controller's call C1).** This keeps 0.2 hashes stable without API-side aliasing:
  - `find` with `limit: 1` and `singleBatch` → `findOne`;
  - `update` statements with `multi: true` → `updateMany`, otherwise `updateOne`;
  - `delete` statements with `limit: 1` → `deleteOne`, `limit: 0` → `deleteMany`;
  - `findAndModify` → `findOneAndUpdate`, or `findOneAndDelete` when `remove: true`;
  - an `aggregate` whose pipeline is exactly `[$match, $group {_id: 1, n: {$sum: 1}}]` (how `countDocuments` reaches the driver on 4+) → `countDocuments`, with the `$match` as its filter shape.
  - The table above lists the raw driver commands; this mapping decides the name shown. Raw-driver apps get the same names, which is more informative than `update`. A real `find().limit(1)` is labelled `findOne`; that is accepted.
  - Names with no driver-level difference (`findById` → `findOne`, `replaceOne` → `updateOne`) may still change hash; the spike lists them and the release notes say so.
- **Discriminators (controller's call C2):** several models can share one collection. When the filter has the discriminator key (`__t` by default, or the schema's `discriminatorKey`) with a value matching a registered discriminator, that model's name is used and the key is dropped from the shape, as 0.2 did. Otherwise the base model's name is used.
- **Multi-statement commands:** an `update` or `delete` with N statements becomes one event with N statements. Each distinct statement shape is counted once per event, and the event's duration is attributed to each. This is the controller's call; it overstates the time of each statement in a bulk write, which is acceptable because the dashboard ranks shapes, not totals.

## Signature, redaction and samples

- `buildSignature`, `flattenFilter`, `classifyOp`, `redact` and the EJSON sample writer stay as they are. They already take plain objects, and driver commands carry the same BSON values Mongoose passes.
- The signature's model part is the resolved model name, or the collection name.
- **Privacy is unchanged and stays the hard rule:** driver events carry real values, so the command goes through the same redaction before anything leaves the process. The raw command object is never logged, never kept beyond sample capture, and never sent unencrypted. The existing "no values leak" integration test is extended to driver capture.

## Wire format and API

- **Each item gains two optional fields (controller's call C4):** `source` (`"mongodb"` for now; project 2 adds `"prisma"` and the SQL dialects) and `collection` (the real collection name, kept even when a model name was resolved).
  - They are per item, not per payload, because one process may use MongoDB and Prisma at once (project 2).
  - 0.3 always sends both.
  - Add them in `packages/contract/src/schema.ts` and the SDK's copy in `types.ts`, kept equal by `sdk-types-equality.test.ts`.
  - Payloads from SDK 0.1 and 0.2, which have neither field, must still validate and store exactly as now. When the fields are absent, the API treats the source as `mongodb`.
- **API:** store `source` and `collection` on `QuerySignature`. Both are nullable; a null source reads as `mongodb`. The ingest writer sets them on insert, the same way it handles `filterShape`.
- **Dashboard:** the Compass card's collection guess (`apps/web/src/compass.ts` `defaultCollection`) uses the stored `collection` when present and falls back to today's lowercase-plural guess. Nothing else in the UI changes in this project.

## Versions

Target support (the spike confirms, narrows or widens each line):

| Library | Majors | Status |
|---|---|---|
| `mongodb` driver | 4, 5, 6, and 7 if released | supported, tested |
| Mongoose | 6, 7, 8, and 9 if released | supported, tested |
| Mongoose 5 / driver 3.x | — | best effort: in or out, depending on what the spike finds about its monitoring API |

- `peerDependencies`: `mongoose` becomes **optional** (`peerDependenciesMeta`) with the widened range, and `mongodb` is added as an optional peer. The SDK still has **zero runtime dependencies**, and the tsup build marks both as external.
- `engines.node` stays at `>=20`.

## Phases (the user's structure)

### Phase 1: technical spike

Short and throwaway. The output is a decision document, `docs/superpowers/specs/2026-10-25-mongodb-driver-monitoring-spike.md`, that answers:
1. Monitoring initialisation: can it be enabled after connect, for each driver major? If not, what does the user have to set, and where?
2. Event matching: are `requestId`/`connectionId` reliable for pairing starts and ends? How is `getMore` tied back to its originating cursor?
3. Duration reporting: the unit and precision of `duration` in each major.
4. Model resolution: does the registry map give the right model for every connection, including `useDb()` and a model whose collection name was set explicitly?
5. The final supported-version table, including the Mongoose 5 verdict.

If any answer contradicts this spec, the spike document says so. The plan follows the spike, and the user is told before Phase 2 starts.

### Phase 2: core implementation

- A shared command-monitoring layer feeds the existing aggregator call (`aggregator.add(sig, durationMs, sample, rawSample)`), the only seam that already knows nothing about the database.
- The current Mongoose API is preserved; the middleware hooks and internals patching are removed.
- The raw-driver entry points (`mongoClient`, `instrument`) are added.
- Payloads stay backward compatible.
  - 0.3 payloads add `source` and `collection` to every item.
  - The byte-identical rule (`index.ts:125-146`) now means: payloads from 0.1 and 0.2 senders keep validating and storing exactly as today. The zod schema strips unknown keys, so the order of deploying the API and publishing the SDK doesn't matter.
- The API stores the new fields, and the web uses `collection` for the Compass guess.

### Phase 3: compatibility and regression tests

Against a real MongoDB through mongodb-memory-server, as the current integration test does:
- Every supported driver major, and every Mongoose major on top of its own driver. Installing several majors side by side through npm aliases in a test-only package is the controller's suggestion; the builder chooses the mechanism.
- More than one connection and `useDb()`.
- Concurrent operations, including cursors with `getMore`.
- Failed commands.
- Redaction and no-values-leak, for every command type in the table.
- **Overhead:** a benchmark of N operations with the SDK on and off. The added cost is reported in the release notes; there is no fixed pass/fail number.

The existing SDK, contract, API and web tests keep passing. Tests for removed middleware internals are replaced, not deleted silently.

### Phase 4: release 0.3.0

- Publish `@vivekumar08/query-analyser@0.3.0` to npm. **Publishing happens only after the user says so.**
- The README covers:
  - migration notes from 0.2 (nothing to do for Mongoose 8 users);
  - the raw-driver setup;
  - the supported-version table;
  - the exact connection setting, if the spike shows one is needed for some versions.
- Copy that says "mongoose 8" (`apps/web/app/page.tsx:47`, `components/onboarding/InstallStep.tsx:192`) is updated to the supported range, and onboarding shows the raw-driver line next to the Mongoose one.
- The "MongoDB queries" email copy stays: it is still true.

## Non-goals

- Prisma, SQL and any other database (project 2).
- The dashboard redesign (project 3).
- The MCP server (project 4).
- Explain plans or new kinds of advice. Index advice stays as it is.
- Capturing error codes or messages from failed commands.

## Anti-goals: a failure even if it works

- A real value leaves the user's process unredacted or unencrypted.
- Mongoose 8 users on 0.2 see their signatures change (hash, model or operation) after upgrading, which would split their history. **Hashes for the same query shape must stay stable between 0.2 and 0.3** wherever the operation name can be kept. Where it can't (e.g. `findOne`, `countDocuments`, `updateOne` → driver names), the spike document lists the cases, and the plan decides how to keep history continuous (for example, mapping or aliasing on the API) and tells the user.
- The SDK makes the app slower in a way users notice, or throws into their code. Every listener is wrapped so an SDK error can never reach the app.
- A new runtime dependency.

## Rulings left to the builder

- Bounds for the in-flight start map, and the `getMore` matching details.
- File layout inside `packages/sdk/src` for the monitoring layer.
- The test-matrix mechanism.
- Whether the operation-name mapping lives in the SDK or the API, within the anti-goal on stable hashes.
