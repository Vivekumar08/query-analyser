# MongoDB Driver Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture queries from the MongoDB driver's command-monitoring events instead of Mongoose middleware. SDK 0.3 then covers Mongoose 6–9 (5 best effort) and raw `mongodb` 4–7 apps with no setup, keeps every 0.2 Mongoose 8 hash, and carries `source` and `collection` through the API to the Compass card.

**Architecture:**
- `packages/sdk` gains five focused modules that feed the existing `Aggregator`:
  - `command-map.ts`: a pure mapper from a driver command to 0.2-style operation names and shapes;
  - `model-registry.ts`: resolves `(db, collection)` to a Mongoose model name;
  - `capture.ts`: builds the signature and redacted sample;
  - `monitor.ts`: pairs start and end events per client and handles cursors;
  - `drivers.ts`: peer resolution, the `MongoClient.prototype.connect` wrap, and monitoring detection.

  `hooks.ts` and the internals patching in `index.ts` are deleted.
- `init()` wraps `connect` of every driver copy it can reach, so clients that connect later have monitoring on. It also attaches to clients that already exist and warns once for each one whose monitoring is off. `init({ mongoClient })` and `instrument(client)` cover clients the SDK can't reach.
- Items gain `source` and `collection`. The contract makes both optional, the API stores them (nullable) and returns them on the detail endpoint, and the web uses `collection` for the Compass guess.
- A private, test-only workspace package, `packages/sdk-compat`, runs the version matrix (drivers 4–7 and Mongoose 5–9, installed as npm aliases) and the overhead benchmark.

**Tech Stack:** TypeScript, Node ≥20, tsup, Vitest 2, mongodb-memory-server 10 (mongod 7.0.24, and 8.0.4 for `MongoClient.bulkWrite`; both are cached in `~/.cache/mongodb-binaries`), zod, Fastify 5 + Prisma 7 (Postgres), Next 16 / React 19 + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-23-mongodb-driver-monitoring-design.md` (the approved design) and `docs/superpowers/specs/2026-10-25-mongodb-driver-monitoring-spike.md` (the spike results). Read both. The spec is the authority, the spike corrects it where they disagree, and the user's rulings after the spike override both. Every resolution is listed under "Decisions" below.

## Global Constraints

- **SDK dependencies:**
  - Zero runtime dependencies (`"dependencies": {}`).
  - `mongoose` and `mongodb` are optional peers: `"peerDependencies": { "mongoose": ">=5.13 <10", "mongodb": ">=4 <8" }` and `"peerDependenciesMeta": { "mongoose": { "optional": true }, "mongodb": { "optional": true } }`.
  - tsup `external: ['mongoose', 'mongodb']`. SDK source never imports either at runtime. Drivers are reached through `createRequire` or passed in, and typed structurally.
  - `engines.node` stays `>=20`.
- No other package gains a runtime dependency. `packages/sdk-compat` is private and has devDependencies only.
- **Public SDK surface:** `init`, `shutdown`, `instrument`, `SDK_VERSION`, the default export `{ init, shutdown, instrument }`, and the types `InitOptions`, `Analyser` and `MongoClientLike`. Existing `InitOptions` fields keep their meaning. One field is added: `mongoClient?: MongoClientLike | MongoClientLike[]`.
- **Never throw into app code.** Every listener body, the connect wrapper, `init()`'s attach path and `instrument()` are wrapped in `try`/`catch`. Failures go to `onError`, which is itself guarded.
- **Zero-setup:**
  - `init()` wraps `MongoClient.prototype.connect` of the resolved `mongodb` and of `mongoose.mongo.MongoClient`, deduplicated by identity.
  - The wrap is idempotent. It returns exactly what the original returns and passes the arguments through untouched, so both the promise and the callback forms work.
  - `shutdown()` restores the original only when the SDK's wrapper is still the top-most `connect`. Otherwise the wrapper stays as a pass-through.
- **Monitoring:**
  - There is no opt-out.
  - The SDK never touches driver internals (`client.s`, `topology`). On driver 3 it neither enables monitoring nor detects whether it is on.
- **Monitoring-off warning,** verbatim, at most once per client:
  `query-analyser: command monitoring is off for a MongoClient, so if this client was already connected its queries are not captured. Pass \`monitorCommands: true\` in its connect options, or call init() before connecting.`
- **Unresolved warning,** verbatim: `query-analyser: neither mongoose nor mongodb could be resolved and no mongoClient was given; pass init({ mongoose }) or init({ mongoClient })`.
- **Privacy (the hard rule):**
  - The sample input is exactly the `{ filter, update?, sort? }` or `{ pipeline }` object 0.2 built, taken from named command fields. `insert` has no sample.
  - The SDK never passes, logs or keeps the whole command (`lsid`, `$clusterTime`, `$db`, `documents`), or any reply field other than `cursor.id`.
  - The start event's command reference is dropped when its end event arrives or when its entry is evicted.
- **Hash stability:** the 35 golden Mongoose 8 cases give 0.2's exact `signature`, `hash`, `model`, `operation`, `filterShape`, `sortKeys`, `stages` and `sample`. The fixture is recorded in Task 1 and checked in Task 9.
- **Duration:** the event's `duration`, rounded to an integer millisecond. A command counts when `durationMs >= thresholdMs` (default 100). No precision claims, anywhere.
- **Bounds, per client:**
  - in-flight starts: at most 2,000 entries, none older than 600,000 ms;
  - open cursors: at most 2,000 entries, none idle for more than 600,000 ms;
  - the oldest entry is evicted first.
- **Wire format:**
  - Every 0.3 item carries `source: 'mongodb'` and `collection` (the real collection name, at most 255 characters), after `sample` and before `encryptedSample`.
  - `model` is at most 200 characters.
  - Payloads without the two fields (SDK 0.1 and 0.2) validate and store exactly as today. An absent `source` reads as `mongodb`.
- **Mongoose 5.13 / driver 3.7:** best effort. It needs `monitorCommands: true` in the connect options. It gets one smoke test and no other guarantee.
- **Publishing:** `@vivekumar08/query-analyser@0.3.0` is published only when the user says so. No task runs `npm publish` or `pnpm publish`.
- **Commits:** conventional (`feat(sdk): …`, `test(sdk): …`, `feat(api): …`, `feat(web): …`, `chore(sdk): …`), with no `Co-Authored-By` or other trailer. Never push.
- **Commands:**
  - SDK: `pnpm --filter @vivekumar08/query-analyser <test|typecheck|build>`. One file: `pnpm --filter @vivekumar08/query-analyser exec vitest run <file>`.
  - The SDK reads the contract's `dist`, so rebuild it with `pnpm --filter @query-analyser/contract build` after any contract change.
  - API tests need `pnpm --filter @query-analyser/api db:generate` and Postgres at `DATABASE_URL`. Run full suites under `caffeinate -i`.
- **Existing tests:** every one stays green, and no assertion is weakened. A test of the removed middleware is replaced, never deleted silently; Task 8 lists each replacement.

## Review Focus

- **Serverless code that calls `instrument(client)` on every invocation with one cached client:** one set of listeners, at most one warning, no double counts. Pinned in Task 8.
- **A client from a driver copy the SDK can't resolve** (a bundler's inlined `mongodb`, or a nested `node_modules`): passing it as `mongoClient` or to `instrument()` captures it. Pinned in Task 8.
- **Another library also patches `MongoClient.prototype.connect`** (APM agents), before or after `init()`: its patch keeps working, `shutdown()` never removes it, and a second `init()` doesn't stack a second SDK wrapper. Pinned in Task 7.
- **A raw-driver collection name over 200 characters:** used as the model name, it would break the schema's `model` maximum and 400 the whole batch. It is truncated (model to 200, collection to 255) and the batch is accepted. Pinned in Task 5.
- **Cursors that are never exhausted or closed** (an early `break` out of `for await`, a stream left open): cursor entries are evicted by size and by idle age, so memory stays bounded. Pinned in Task 6.

## Decisions (spec, spike and rulings)

1. **Monitoring can't be switched on for a client that is already connected,** on any driver major (spike Q1). This contradicts the spec's working assumption.
   - Zero-setup comes from the connect wrap instead (user ruling).
   - A client seen after it connected without monitoring gets the single warning above. The warning says "if this client was already connected" because drivers 4+ have no public connected flag.
   - The README stops saying "Call `init()` anywhere" and says to call `init()` before connecting.
2. **Timing:** the spec's "finer than `Date.now()`" claim is dropped. Duration stays integer milliseconds (spike Q3). The release notes say 0.3 measures database time and claim no precision gain.
3. **Operation names:** the spec's C1 mapping is applied with the spike's four corrections:
   - `countDocuments` allows `$skip` and `$limit` between `$match` and `$group`;
   - `replaceOne` and `findOneAndReplace` are detected from the update document;
   - `find().limit(1)` without `singleBatch` stays `find`;
   - a `Map` sort is converted to a plain object before `buildSignature` and `redact`.

   The mapping lives in the SDK, so no aliasing is needed on the API.
4. **Discriminators (C2 as the spike corrects it):** the discriminator key stays in the shape, as in 0.2, and is used only to pick the model name. The spec's "drop the key" would change hashes.
5. **Model registry:**
   - It walks `mongoose.connections` and each connection's `otherDbs` (guarded, because it's untyped), and falls back to the collection name alone when every model on that collection has the same name.
   - Connections created later are covered by the connect wrap, so the untyped `mongoose.events` isn't used.
   - When two base models share one namespace, the first one registered wins.
6. **`MongoClient.bulkWrite`:** it reaches the driver as a single `bulkWrite` command on the `admin` db, and it is captured per statement. The admin/local/config skip rule applies to each statement's own namespace instead (user ruling).
7. **Event pairing:** the in-flight map is per client (in the listener closure) and keyed by `requestId`. `connectionId` is only a cross-check: when it disagrees, the pair is dropped. The bounds are the ones in Global Constraints.
8. **`getMore`:** "added to its time" means the occurrence's duration grows. Its histogram bucket moves, and `totalMs` and `maxMs` update. `count`, `lastMs`, `lastTs` and the sample stay as they are.
   - When the first command was under the threshold, or its window has already been flushed, a `getMore` at or over the threshold starts one occurrence under the originating signature. Later `getMore`s on that cursor extend it.
   - The cursor key is `` `${db}.${collection}#${cursorId}` ``.
9. **Mongoose 5:** in, best effort (user ruling). The peer range is `>=5.13 <10`.
10. **API writer:** it also fills a null `source` or `collection` on conflict, with `COALESCE` against the stored value. 0.3 keeps 0.2's hashes, so most Mongoose signatures already exist and would otherwise never get a collection. The spec says "on insert"; this extends it rather than contradicting it.
11. **Schema types:** `source` is a free string (`min 1, max 40`), not an enum, so project 2's values don't 400 on an API that hasn't been redeployed. `collection` is limited to 255 characters (MongoDB's namespace limit).
12. **`insert`** items carry `sample: null`. The spike allowed keeping a redacted sample; this plan keeps none.
13. **`installedModels`** now means the number of Mongoose models in the registry when `init()` runs.
14. **Mongoose 9:** 0.2 throws `TypeError: next is not a function` into app code. 0.3 has no middleware, and a compat test pins that nothing throws (Task 12).
15. **Release:** the spec's Phase 4 "publish" becomes "prepare" (user ruling). The name `instrument` is kept.

---

## File Structure

**SDK (`packages/sdk`)**
- `src/command-map.ts` (new): driver command → `MappedStatement[]` (allow-list, ignored dbs, the C1 mapping, `bulkWrite`). Test: `src/command-map.test.ts`.
- `src/model-registry.ts` (new): `createModelResolver`. Test: `src/model-registry.test.ts`.
- `src/capture.ts` (new): `shapeOf` (signature, redacted sample, truncation). Test: `src/capture.test.ts`.
- `src/monitor.ts` (new): the sink holder, `attachClient`, the per-client in-flight and cursor maps. Test: `src/monitor.test.ts`.
- `src/drivers.ts` (new): `resolvePeer`, `monitorState`, `enableMonitoring`, `installConnectWrap`, `undoConnectWraps`, `mongooseClients`. Test: `src/drivers.test.ts`.
- `src/aggregator.ts`: occurrences, `extend`, `collection`. `src/types.ts`: the two new optional fields.
- `src/index.ts`: `init`, `instrument` and `shutdown` on the driver layer. Tests: `src/index.test.ts` and the new `src/init-unresolved.test.ts`.
- Deleted: `src/hooks.ts`, `src/hooks.test.ts`.
- `src/__tests__/golden-cases.ts`, `golden-0.2.json` (fixture) and `golden.test.ts`. `golden-record.test.ts` exists from Task 1 to Task 8 only.
- `src/__tests__/integration.test.ts`, `package.json`, `tsup.config.ts`, `README.md`, `CHANGELOG.md` (new).

**Contract:** `packages/contract/src/runtime.ts`, `src/schema.ts`, `src/schema.test.ts`, `src/sdk-types-equality.test.ts`.

**API:** `apps/api/prisma/schema.prisma`, `prisma/migrations/<ts>_signature_source_collection/migration.sql`, `src/ingest/writer.ts`, `src/analysis/routes.ts`, and the tests next to them.

**Web:** `apps/web/src/dashboard-types.ts`, `components/dashboard/CompassQuery.tsx`, `app/dashboard/[org]/[app]/queries/[sig]/page.tsx`, `app/page.tsx`, `components/onboarding/InstallStep.tsx`, `components/onboarding/snippet.ts`, and their tests.

**Compat (`packages/sdk-compat`, new, private):** `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/harness.ts`, `src/drivers.test.ts`, `src/mongoose.test.ts`, `src/mongoose5.test.ts`, `src/overhead.test.ts`.

---

## Phase 2: core

### Task 1: SDK — record 0.2's output for the 35 golden Mongoose 8 cases

This runs against today's code, before anything changes, so the fixture is 0.2's real output.

**Files:**
- Create: `packages/sdk/src/__tests__/golden-cases.ts`
- Create: `packages/sdk/src/__tests__/golden-record.test.ts` (deleted again in Task 8)
- Create (generated): `packages/sdk/src/__tests__/golden-0.2.json`

**Interfaces:**
- Consumes: today's `init`, `shutdown` from `../index.js`.
- Produces:
  - `interface GoldenModels { User; Thing; Animal; Dog; Stamped }`, each a Mongoose `Model`;
  - `interface GoldenIds { userId: Types.ObjectId; spareId: Types.ObjectId }`;
  - `buildGoldenModels(conn: mongoose.Connection): GoldenModels`;
  - `seedGolden(m: GoldenModels): Promise<GoldenIds>`;
  - `GOLDEN_CASES: ReadonlyArray<{ name: string; run(m: GoldenModels, ids: GoldenIds): Promise<unknown> }>`, exactly 35 entries;
  - `GOLDEN_FIELDS = ['signature', 'hash', 'model', 'operation', 'filterShape', 'sortKeys', 'stages', 'sample'] as const`;
  - the fixture `golden-0.2.json`: `{ sdkVersion: '0.2.0', mongoose: string, cases: Record<caseName, Pick<IngestItem, GOLDEN_FIELDS>> }`.

- [ ] **Step 1: Write `golden-cases.ts`**

Model names and fields are part of every hash, so they are fixed exactly:

```ts
User    = conn.model('GoldenUser', new Schema({ email: String, name: String, age: Number, tags: [String], address: { city: String }, createdAt: Date }));
Thing   = conn.model('GoldenThing', new Schema({ a: Number }, { collection: 'my_things' }));
Animal  = conn.model('GoldenAnimal', new Schema({ name: String, a: Number }));
Dog     = Animal.discriminator('GoldenDog', new Schema({ breed: String }));
Stamped = conn.model('GoldenStamped', new Schema({ status: String }, { timestamps: true }));
```

`seedGolden` creates two users (`a@x.test` with age 1, and `spare@x.test`) and one `Dog` named `rex`, and returns their ids. The 35 cases, in this order (`U` = `m.User`):

| # | name | call |
|---|---|---|
| 1 | `find-eq` | `U.find({ email: 'a@x.test' })` |
| 2 | `find-range-sort` | `U.find({ age: { $gte: 18 } }).sort({ age: -1 })` |
| 3 | `find-in` | `U.find({ email: { $in: ['a@x.test', 'b@x.test'] } })` |
| 4 | `find-or` | `U.find({ $or: [{ email: 'a@x.test' }, { name: 'b' }] })` |
| 5 | `find-regex` | `U.find({ name: /^an/i })` |
| 6 | `find-exists-ne` | `U.find({ name: { $exists: true }, age: { $ne: 3 } })` |
| 7 | `find-nested-path` | `U.find({ 'address.city': 'Pune' })` |
| 8 | `find-string-sort` | `U.find({ age: 1 }).sort('-createdAt name')` |
| 9 | `find-limit-1` | `U.find({ age: 1 }).limit(1)` |
| 10 | `find-explicit-collection` | `m.Thing.find({ a: 1 })` |
| 11 | `findOne` | `U.findOne({ email: 'a@x.test' })` |
| 12 | `findOne-sort` | `U.findOne({ age: { $lt: 9 } }).sort({ age: 1 })` |
| 13 | `findById` | `U.findById(ids.userId)` |
| 14 | `exists` | `U.exists({ email: 'a@x.test' })` |
| 15 | `countDocuments` | `U.countDocuments({ age: 1 })` |
| 16 | `countDocuments-skip-limit` | `U.countDocuments({ age: 1 }).skip(1).limit(5)` |
| 17 | `distinct` | `U.distinct('name', { age: 1 })` |
| 18 | `updateOne-set` | `U.updateOne({ email: 'a@x.test' }, { $set: { age: 2 } })` |
| 19 | `updateMany-inc` | `U.updateMany({ age: 1 }, { $inc: { age: 1 } })` |
| 20 | `updateOne-no-dollar` | `U.updateOne({ email: 'a@x.test' }, { age: 3 })` |
| 21 | `updateOne-timestamps` | `m.Stamped.updateOne({ status: 'a' }, { $set: { status: 'b' } })` |
| 22 | `replaceOne` | `U.replaceOne({ email: 'a@x.test' }, { email: 'a@x.test', age: 4 })` |
| 23 | `deleteOne` | `U.deleteOne({ email: 'gone@x.test' })` |
| 24 | `deleteMany` | `U.deleteMany({ age: { $gt: 1000 } })` |
| 25 | `doc-deleteOne` | `U.hydrate({ _id: ids.spareId, email: 'spare@x.test' }).deleteOne()` |
| 26 | `findOneAndUpdate` | `U.findOneAndUpdate({ email: 'a@x.test' }, { $set: { age: 5 } })` |
| 27 | `findByIdAndUpdate` | `U.findByIdAndUpdate(ids.userId, { $inc: { age: 1 } })` |
| 28 | `findOneAndUpdate-sort` | `U.findOneAndUpdate({ age: 1 }, { $set: { name: 'z' } }, { sort: { age: -1 } })` |
| 29 | `findOneAndDelete` | `U.findOneAndDelete({ email: 'gone@x.test' })` |
| 30 | `findOneAndReplace` | `U.findOneAndReplace({ email: 'a@x.test' }, { email: 'a@x.test', age: 6 })` |
| 31 | `aggregate` | `U.aggregate([{ $match: { age: 1 } }, { $group: { _id: '$name', n: { $sum: 1 } } }])` |
| 32 | `discriminator-find` | `m.Dog.find({ name: 'rex' })` |
| 33 | `discriminator-findOne` | `m.Dog.findOne({ name: 'rex' })` |
| 34 | `discriminator-updateMany` | `m.Dog.updateMany({ breed: 'lab' }, { $set: { name: 'max' } })` |
| 35 | `discriminator-countDocuments` | `m.Dog.countDocuments({ name: 'rex' })` |

Every `run` returns the awaited query (calling `.exec()` where the call returns a `Query`).

- [ ] **Step 2: Write `golden-record.test.ts`**

`describe.runIf(process.env.QA_RECORD_GOLDEN === '1')('record 0.2 golden output', …)` holds one test, `'records one 0.2 item per golden case'`:
1. start `MongoMemoryServer`;
2. capture bodies with the same gzip-aware `capture()` as `integration.test.ts`;
3. call `init({ apiKey: 'k', app: 'golden', thresholdMs: 0, mongoose, fetchImpl })`;
4. `conn = await mongoose.createConnection(uri).asPromise()`, then `buildGoldenModels(conn)` and `seedGolden`;
5. `await a.flush()` and discard what it sent;
6. for each case: `await c.run(m, ids)`, `await a.flush()`, then `expect(items).toHaveLength(1)` and keep the item's `GOLDEN_FIELDS`;
7. write `golden-0.2.json` (2-space JSON, cases in table order) next to the test, with `mongoose: mongoose.version`.

If any case yields anything other than one item, stop and report it. Do not change the case list.

- [ ] **Step 3: Record**

Run: `QA_RECORD_GOLDEN=1 pnpm --filter @vivekumar08/query-analyser exec vitest run src/__tests__/golden-record.test.ts`
Expected: 1 passed.

Run: `node -e "const g=require('./packages/sdk/src/__tests__/golden-0.2.json');console.log(Object.keys(g.cases).length,g.cases['find-limit-1'].operation,g.cases.findById.operation,g.cases['discriminator-find'].signature)"`
Expected: `35 find findOne GoldenDog.find(__t:eq,name:eq)`

- [ ] **Step 4: Run the SDK suite without the flag**

Run: `pnpm --filter @vivekumar08/query-analyser test`
Expected: all pass, with the record test skipped.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/__tests__/golden-cases.ts packages/sdk/src/__tests__/golden-record.test.ts packages/sdk/src/__tests__/golden-0.2.json
git commit -m "test(sdk): record 0.2 signatures for 35 mongoose 8 query shapes"
```

---

### Task 2: Contract — optional `source` and `collection` on ingest items

**Files:**
- Modify: `packages/contract/src/runtime.ts` (`IngestItem`), `packages/contract/src/schema.ts` (`ingestItemSchema`)
- Modify: `packages/sdk/src/types.ts` (`IngestItem`)
- Test: `packages/contract/src/schema.test.ts`, `packages/contract/src/sdk-types-equality.test.ts`

**Interfaces:**
- Produces: `IngestItem.source?: string` and `IngestItem.collection?: string`, identical in the contract and the SDK, each with a doc comment. Schema: `source: z.string().min(1).max(40).optional()` and `collection: z.string().min(1).max(255).optional()`.

- [ ] **Step 1: Write the failing tests**

`schema.test.ts` gets a new `describe('ingest item source and collection')` that reuses `item` and `payload`:

```ts
it('accepts a 0.2 item with neither field and leaves both absent', () => {
  const parsed = ingestPayloadSchema.parse(payload);
  expect(parsed.items[0]).not.toHaveProperty('source');
  expect(parsed.items[0]).not.toHaveProperty('collection');
});
it('accepts a 0.3 item with both', () =>
  expect(ingestPayloadSchema.parse({ ...payload, items: [{ ...item, source: 'mongodb', collection: 'orders' }] }).items[0])
    .toMatchObject({ source: 'mongodb', collection: 'orders' }));
it('accepts a source it does not know yet', () =>
  expect(ingestPayloadSchema.safeParse({ ...payload, items: [{ ...item, source: 'prisma' }] }).success).toBe(true));
it.each([{ source: '' }, { collection: '' }, { source: 'x'.repeat(41) }, { collection: 'c'.repeat(256) }])('rejects %o', (extra) =>
  expect(ingestPayloadSchema.safeParse({ ...payload, items: [{ ...item, ...extra }] }).success).toBe(false));
it('strips unknown item keys rather than rejecting them', () =>
  expect(ingestPayloadSchema.parse({ ...payload, items: [{ ...item, future: 1 }] }).items[0]).not.toHaveProperty('future'));
```

`sdk-types-equality.test.ts`:

```ts
type _ItemCarriesOrigin = AssertTrue<Equal<IngestItem['source'] | IngestItem['collection'], string | undefined>>;
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/contract test`
Expected: FAIL. The 0.3 item loses both keys, and `_ItemCarriesOrigin` doesn't compile.

- [ ] **Step 3: Add the fields** to both `IngestItem` copies (after `sample`) and to `ingestItemSchema`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/contract test && pnpm --filter @query-analyser/contract typecheck && pnpm --filter @query-analyser/contract build && pnpm --filter @vivekumar08/query-analyser typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src packages/sdk/src/types.ts
git commit -m "feat(contract): optional source and collection on ingest items"
```

---

### Task 3: SDK — map driver commands to 0.2 operation names and shapes

**Files:**
- Create: `packages/sdk/src/command-map.ts`, `packages/sdk/src/command-map.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MappedStatement {
  database: string;
  collection: string;
  /** The 0.2 operation name. */
  operation: string;
  filter?: unknown;
  /** Always a plain object, never a Map. */
  sort?: unknown;
  pipeline?: unknown[];
  /** Exactly the object 0.2 handed to redact(); null for insert. */
  sampleInput: Record<string, unknown> | null;
}
export const CAPTURED_COMMANDS: ReadonlySet<string>; // find aggregate insert update delete findAndModify count distinct bulkWrite
export function isIgnoredDatabase(database: string): boolean; // admin, local, config
export function toPlainSort(sort: unknown): unknown;           // Map → Object.fromEntries; anything else returned as is
export function isCountDocumentsPipeline(pipeline: unknown): boolean;
export function mapCommand(commandName: string, database: string, command: Record<string, unknown>): MappedStatement[];
```

The rules (`mapCommand` returns `[]` for anything not listed, and never throws):

| command | collection | operation | filter / sort / pipeline | sampleInput |
|---|---|---|---|---|
| `find` | `command.find` | `findOne` when `limit === 1 && singleBatch === true`, else `find` | `filter ?? {}`, `toPlainSort(sort)` | `{ filter, sort? }` |
| `aggregate` matching the countDocuments pipeline | `command.aggregate` | `countDocuments` | filter = `pipeline[0].$match` | `{ filter }` |
| other `aggregate` | `command.aggregate` (`[]` when it isn't a non-empty string, e.g. `aggregate: 1`) | `aggregate` | `pipeline` | `{ pipeline }` |
| `update`, per statement in `updates` | `command.update` | `updateMany` if `multi === true`; else `replaceOne` if `u` is a non-array object with no `$` key; else `updateOne` | filter `q`, `toPlainSort(statement.sort)` | `{ filter: q, update: u, sort? }` |
| `delete`, per statement in `deletes` | `command.delete` | `deleteOne` if `limit === 1`, else `deleteMany` | filter `q` | `{ filter: q }` |
| `findAndModify` | `command.findAndModify` | `findOneAndDelete` if `remove === true`; `findOneAndUpdate` if `update` is an array or has a `$` key; else `findOneAndReplace` | `query ?? {}`, `toPlainSort(sort)` | `{ filter, update?, sort? }` (no `update` for delete) |
| `count` / `distinct` | `command.count` / `command.distinct` | the same name | `query ?? {}` | `{ filter }` |
| `insert` | `command.insert` | `insert` | — | `null` |
| `bulkWrite` (`admin`), per entry in `ops` | from `nsInfo[i].ns`, split at the first `.` | `insert`, update ops as in the `update` row (`filter` and `updateMods` in place of `q` and `u`), delete ops `deleteMany` if `multi === true`, else `deleteOne` | as in those rows | as in those rows |

- The countDocuments pipeline is `[{ $match }, ({ $skip })?, ({ $limit })?, { $group: { _id: 1, n: { $sum: 1 } } }]`. Each stage has exactly one key, the `$group` matches exactly, and `$skip` and `$limit` keep that order.
- Keys with an `undefined` value are left out of `sampleInput`, as in 0.2.
- A command on an ignored database returns `[]`, except `bulkWrite`. For `bulkWrite`, each statement whose own namespace's database is ignored is dropped.

- [ ] **Step 1: Write the failing tests**

One test per table row, plus these:

```ts
it('find: a Map sort becomes a plain object in both the sort and the sample', () =>
  expect(mapCommand('find', 'app', { find: 'users', filter: { a: 1 }, sort: new Map([['age', -1]]) })).toEqual([
    { database: 'app', collection: 'users', operation: 'find', filter: { a: 1 }, sort: { age: -1 }, sampleInput: { filter: { a: 1 }, sort: { age: -1 } } },
  ]));
it('find: limit 1 with singleBatch is findOne; limit 1 alone stays find', () => { /* operation 'findOne' / 'find' */ });
it('find with no filter uses {} like 0.2', () => { /* filter {} and sampleInput { filter: {} } */ });
it.each([
  [[{ $match: { a: 1 } }, { $group: { _id: 1, n: { $sum: 1 } } }]],
  [[{ $match: { a: 1 } }, { $skip: 1 }, { $limit: 5 }, { $group: { _id: 1, n: { $sum: 1 } } }]],
  [[{ $match: { a: 1 } }, { $limit: 5 }, { $group: { _id: 1, n: { $sum: 1 } } }]],
])('countDocuments pipeline %#', (pipeline) =>
  expect(mapCommand('aggregate', 'app', { aggregate: 'users', pipeline })[0]).toEqual(
    { database: 'app', collection: 'users', operation: 'countDocuments', filter: { a: 1 }, sampleInput: { filter: { a: 1 } } }));
it('a $group that is not the count shape stays an aggregate', () => { /* _id: null → operation 'aggregate', pipeline kept */ });
it('update statements: multi → updateMany, $-less object → replaceOne, pipeline array → updateOne', () => { /* three statements → three entries, in order */ });
it('findAndModify: remove, $-update, pipeline update, replacement', () => { /* findOneAndDelete has no update in sampleInput */ });
it('insert has no shape and no sample', () =>
  expect(mapCommand('insert', 'app', { insert: 'users', documents: [{ email: 'x' }] })).toEqual(
    [{ database: 'app', collection: 'users', operation: 'insert', sampleInput: null }]));
it('MongoClient.bulkWrite on admin maps each op to its own namespace and skips ignored ones', () => {
  const st = mapCommand('bulkWrite', 'admin', {
    bulkWrite: 1,
    nsInfo: [{ ns: 'shop.orders' }, { ns: 'local.x' }],
    ops: [
      { insert: 0, document: { a: 1 } },
      { update: 0, filter: { s: 1 }, updateMods: { $set: { s: 2 } }, multi: true },
      { update: 0, filter: { s: 1 }, updateMods: { s: 3 } },
      { delete: 0, filter: { s: 1 }, multi: false },
      { delete: 1, filter: {} },
    ],
  });
  expect(st.map((s) => `${s.database}.${s.collection}:${s.operation}`)).toEqual(
    ['shop.orders:insert', 'shop.orders:updateMany', 'shop.orders:replaceOne', 'shop.orders:deleteOne']);
});
it.each(['hello', 'ping', 'getMore', 'killCursors', 'endSessions', 'createIndexes', 'explain'])('ignores %s', (name) =>
  expect(mapCommand(name, 'app', { [name]: 'users' })).toEqual([]));
it.each(['admin', 'local', 'config'])('ignores a find on %s', (db) =>
  expect(mapCommand('find', db, { find: 'x', filter: {} })).toEqual([]));
it('never throws on a hostile command', () => {
  const evil = { get find(): never { throw new Error('boom'); } };
  expect(mapCommand('find', 'app', evil)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/command-map.test.ts`
Expected: FAIL, "Failed to load url ./command-map.js".

- [ ] **Step 3: Implement `command-map.ts`** to the table above, as one `switch` on `commandName` inside a `try` that returns `[]` on error. It imports nothing.

- [ ] **Step 4: Run to verify they pass**

Run: the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/command-map.ts packages/sdk/src/command-map.test.ts
git commit -m "feat(sdk): map driver commands to 0.2 operation names and shapes"
```

---

### Task 4: SDK — Mongoose model registry

**Files:**
- Create: `packages/sdk/src/model-registry.ts`, `packages/sdk/src/model-registry.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ModelResolver {
  /** The model name for this namespace, or the collection name when none matches. Never throws. */
  resolve(database: string, collection: string, filter: unknown): string;
  /** Models registered across every reachable connection right now. */
  modelCount(): number;
}
export function createModelResolver(mongoose: object | null): ModelResolver;
```

The rules:
- **Walk:** each connection in `mongoose.connections`, and each connection in its `otherDbs` (read only when `Array.isArray`). For each model in `conn.models`:
  - the name is `model.modelName`;
  - the key is `` `${model.db.name}\u0000${model.collection.collectionName}` ``;
  - a model whose properties throw is skipped.
- **Discriminators:** a model with a string `baseModelName` is a discriminator. Its value is `schema.discriminatorMapping?.value ?? modelName`, and its key is `schema.discriminatorMapping?.key ?? '__t'`.
  - When the filter is a plain object, `filter[key]` is a string, and that string is a registered value on this namespace, the result is the discriminator's name. Otherwise it is the base model's name.
  - When two base models share a namespace, the first one registered wins.
- **Fallback:** on a key miss, if every base model registered under that collection name (across all dbs) has the same name, return that name. Otherwise return the collection name.
- **Rebuild:** the index is rebuilt lazily. On a miss, if `modelCount()` differs from the count at the last build, rebuild once and look up again.

- [ ] **Step 1: Write the failing tests**

Use a `fakeMongoose(conns)` helper that builds `{ connections: [{ models: { Name: { modelName, db: { name }, collection: { collectionName }, baseModelName?, schema? } }, otherDbs? }] }`.

```ts
it('resolves (db, collection) to the model name across connections', () => {
  // app/users → 'User'; analytics/events → 'Event'; analytics/users → 'AnalyticsUser'
});
it('uses explicit collection names', () => { /* app/my_things → 'Thing' */ });
it('walks useDb() connections in conn.otherDbs', () => { /* app/shared → 'A'; tenant_a/shared (only in otherDbs) → 'B' */ });
it('falls back to the collection alone when every model on it has one name', () => { /* tenant_b/users → 'User' */ });
it('returns the collection name when models on that collection have different names', () => { /* tenant_b/shared → 'shared' */ });
it('tolerates a missing or non-array otherDbs and throwing connection getters', () => { /* no throw; collection name returned */ });
it('skips a model whose collection getter throws and still resolves the others', () => { /* First, Last resolve; Middle skipped */ });
it('picks a discriminator from the filter, else the base model', () => {
  const r = createModelResolver(withAnimals);  // Animal base; Dog { key '__t', value 'Dog' }; Cat { key 'kind', value 'cat' } on another namespace
  expect(r.resolve('app', 'animals', { __t: 'Dog', name: 'rex' })).toBe('Dog');
  expect(r.resolve('app', 'animals', { name: 'rex' })).toBe('Animal');
  expect(r.resolve('app', 'animals', { __t: 'Unknown' })).toBe('Animal');
  expect(r.resolve('app', 'pets', { kind: 'cat' })).toBe('Cat');
});
it('first-registered base model wins when two share a namespace', () => { /* 'First' */ });
it('returns the collection name with no mongoose', () => expect(createModelResolver(null).resolve('app', 'orders', {})).toBe('orders'));
it('rebuilds on a miss only when models were added', () => {
  // count reads of `connections` with a getter spy: a second miss with unchanged models → no rebuild;
  // add a model to conn.models → the next resolve finds it
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/model-registry.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `model-registry.ts`** to the rules above. Use one `Map` per index (namespace and collection). Every property read is guarded.

- [ ] **Step 4: Run to verify they pass** (the same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/model-registry.ts packages/sdk/src/model-registry.test.ts
git commit -m "feat(sdk): resolve driver namespaces to mongoose model names"
```

---

### Task 5: SDK — aggregator occurrences, collection on items, capture shapes

**Files:**
- Modify: `packages/sdk/src/aggregator.ts`, `packages/sdk/src/index.ts` (`toWireItem` only)
- Create: `packages/sdk/src/capture.ts`, `packages/sdk/src/capture.test.ts`
- Test: `packages/sdk/src/aggregator.test.ts`, `packages/sdk/src/index.test.ts` (`WIRE_ITEM_KEYS`)

**Interfaces:**
- Consumes: `MappedStatement` (Task 3), `buildSignature`, `redact`, `bucketIndex`.
- Produces:

```ts
// aggregator.ts
export interface Occurrence { readonly hash: string; readonly generation: number; ms: number }
add(sig: SignatureResult, durationMs: number, sample: unknown, rawSample?: unknown, collection?: string): Occurrence | null; // null when dropped at the cap
extend(occ: Occurrence, extraMs: number): boolean; // false once its window was swapped
get generation(): number;                          // +1 on every swap()
// The item's `collection` is set on creation to `collection ?? sig.model`.

// capture.ts
export const MAX_MODEL_CHARS = 200;
export const MAX_COLLECTION_CHARS = 255;
export interface CapturedShape { sig: SignatureResult; sample: unknown; collection: string }
export function shapeOf(st: MappedStatement, model: string): CapturedShape;
// shapeOf: buildSignature({ model: model.slice(0, 200), operation, filter, sort, pipeline }),
// sample = sampleInput === null ? null : redact(sampleInput), collection = st.collection.slice(0, 255).
```

- `extend`: moves one count in `hist` from `bucketIndex(occ.ms)` to `bucketIndex(occ.ms + extraMs)`, adds `extraMs` to `totalMs`, sets `maxMs = max(maxMs, occ.ms + extraMs)`, then `occ.ms += extraMs`.
- `toWireItem` appends `source: 'mongodb'` and `collection: item.collection ?? item.model` after `sample`.

- [ ] **Step 1: Write the failing tests**

`aggregator.test.ts`:

```ts
it('add returns an occurrence and keeps the collection on the item', () => {
  const agg = new Aggregator(10);
  expect(agg.add(sigA, 120, null, undefined, 'orders')).toEqual({ hash: sigA.hash, generation: 0, ms: 120 });
  agg.add(sigB, 120, null);
  const [a, b] = agg.swap().items;
  expect(a!.collection).toBe('orders');
  expect(b!.collection).toBe('User');
});
it('extend grows the occurrence: bucket moves, total and max add, count and lastMs stay', () => {
  const agg = new Aggregator(10);
  const occ = agg.add(sigA, 120, null)!;
  expect(agg.extend(occ, 200)).toBe(true);
  const item = agg.swap().items[0]!;
  expect(item).toMatchObject({ count: 1, totalMs: 320, maxMs: 320, lastMs: 120 });
  expect(item.hist).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
});
it('extend is a no-op once the window was swapped', () => { /* swap, extend → false, next swap has no items */ });
it('add returns null for a new signature past the cap', () => { /* maxSignatures 1, second sig → null */ });
it('merge keeps the collection', () => { /* swap then merge, collection survives */ });
```

`capture.test.ts`:

```ts
it('shapeOf builds the 0.2 signature and redacted sample from the mapped statement', () => {
  const [st] = mapCommand('find', 'app', { find: 'users', filter: { email: 'a@x', age: { $gte: 1 } }, sort: new Map([['age', -1]]) });
  const shape = shapeOf(st!, 'User');
  expect(shape.sig).toEqual(buildSignature({ model: 'User', operation: 'find', filter: st!.filter, sort: { age: -1 } }));
  expect(shape.sample).toEqual({ filter: { email: '<string>', age: { $gte: '<number>' } }, sort: { age: '<number>' } });
  expect(shape.collection).toBe('users');
});
it('insert has a null sample', () => { /* shapeOf(insert).sample === null; sig.signature 'orders.insert()' */ });
it('truncates a model name to 200 and a collection to 255 characters, and the batch validates', () => {
  const long = 'c'.repeat(250);
  const [st] = mapCommand('find', 'app', { find: long, filter: {} });
  const shape = shapeOf(st!, long);   // raw driver: model = collection
  expect(shape.sig.model).toHaveLength(200);
  expect(shape.collection).toHaveLength(250);
  // build an item through Aggregator + toWireItem's key set and check ingestPayloadSchema.safeParse(...).success === true
});
```

`index.test.ts`: `WIRE_ITEM_KEYS` gains `'source', 'collection'` after `'sample'`. The existing `'without a key, a small batch is exactly one POST with the same payload as before'` now also expects `sent.items[0]` to match `{ source: 'mongodb', collection: 'M' }`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/aggregator.test.ts src/capture.test.ts src/index.test.ts`
Expected: FAIL. `add` returns undefined, `capture.js` is missing, and the wire keys differ.

- [ ] **Step 3: Implement** `Occurrence`, `extend` and `generation` in `aggregator.ts`, then `capture.ts`, then the two wire keys in `toWireItem`.

- [ ] **Step 4: Run the SDK suite**

Run: `pnpm --filter @vivekumar08/query-analyser test && pnpm --filter @vivekumar08/query-analyser typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): occurrences that getMore can extend, and collection on every item"
```

---

### Task 6: SDK — per-client command monitor

**Files:**
- Create: `packages/sdk/src/monitor.ts`, `packages/sdk/src/monitor.test.ts`

**Interfaces:**
- Consumes: `mapCommand`, `CAPTURED_COMMANDS`, `isIgnoredDatabase` (Task 3); `shapeOf` (Task 5); `Aggregator.add`/`extend`, `Occurrence` (Task 5).
- Produces:

```ts
export interface MonitorSink {
  aggregator: Aggregator;
  thresholdMs: number;
  onError(e: Error): void;                 // already safe to call
  isDisabled(): boolean;
  captureRawSample(): boolean;
  resolveModel(database: string, collection: string, filter: unknown): string;
}
export const MAX_IN_FLIGHT = 2_000;
export const MAX_IN_FLIGHT_AGE_MS = 600_000;
export const MAX_CURSORS = 2_000;
export const MAX_CURSOR_IDLE_MS = 600_000;
export function setSink(sink: MonitorSink | null): void;
export function currentSink(): MonitorSink | null;
/** Adds the three listeners once per client (guard: Symbol.for('query-analyser.client-attached')). True when added now. */
export function attachClient(client: object): boolean;
/** Test seam. */
export function clientStats(client: object): { inFlight: number; cursors: number } | null;
export function toDurationMs(d: unknown): number | null; // a finite d ≥ 0 → Math.round(d), else null
```

The listeners. Each body is in `try`/`catch`, reported with `sink.onError`. Each reads `currentSink()` per event and does nothing when it is null or `isDisabled()`.

- **`commandStarted`:**
  - Evict head entries older than the age bound.
  - `getMore`: store `{ cursorKey: `${databaseName}.${command.collection}#${String(command.getMore)}` }`.
  - `killCursors`: delete each `` `${db}.${command.killCursors}#${String(id)}` `` in `command.cursors`, and store nothing.
  - Other commands: skip if not in `CAPTURED_COMMANDS`, or if the db is ignored and the command isn't `bulkWrite`. When the map is full, delete the oldest entry. Then set `requestId → { startedAt: Date.now(), commandName, database, command, connectionId }`. For `insert`, store `command: undefined` and keep only the collection name.
- **`commandSucceeded` / `commandFailed`:**
  - Take the entry and delete it. Return if there is none, if both `connectionId`s are defined and `String()`-unequal, or if `toDurationMs` returns null.
  - `getMore`: look up the cursor and touch it (delete, then set, with `lastUsed`). If its occurrence extends, done. Otherwise, at or over the threshold, set the cursor's occurrence to `aggregator.add(shape.sig, d, shape.sample, undefined, shape.collection)`. Delete the cursor on failure or when `String(reply.cursor.id) === '0'`.
  - Otherwise: `statements = mapCommand(...)`, then drop the command reference.
    - `counted = d >= thresholdMs`.
    - `live` = a successful `find`/`aggregate` with one statement whose `String(reply?.cursor?.id)` isn't `'0'` or `'undefined'`.
    - If neither, stop.
    - Shapes come from `shapeOf(st, sink.resolveModel(st.database, st.collection, st.filter))`, deduplicated by `sig.hash`.
    - When counted, `add(sig, d, sample, captureRawSample() ? st.sampleInput ?? undefined : undefined, collection)` for each.
    - When live, store the cursor `{ shape, occurrence (or null), lastUsed }`, evicting by size and idle age like the in-flight map.

- [ ] **Step 1: Write the failing tests**

Helpers:

```ts
class FakeClient extends EventEmitter { options = { monitorCommands: true }; }
let rid = 0;
function run(c: FakeClient, commandName: string, command: object,
  { db = 'app', duration = 150, reply = { ok: 1 } as object, fail = false, connectionId = 1, endConnectionId = connectionId } = {}) {
  const requestId = ++rid;
  c.emit('commandStarted', { requestId, connectionId, databaseName: db, commandName, command });
  c.emit(fail ? 'commandFailed' : 'commandSucceeded',
    { requestId, connectionId: endConnectionId, duration, commandName, ...(fail ? { failure: new Error('x') } : { reply }) });
  return requestId;
}
const sink = (over: Partial<MonitorSink> = {}): MonitorSink => ({ aggregator: new Aggregator(100), thresholdMs: 100,
  onError: vi.fn(), isDisabled: () => false, captureRawSample: () => false, resolveModel: (_d, coll) => coll, ...over });
afterEach(() => { setSink(null); vi.useRealTimers(); });
```

Tests (each calls `setSink(s)` and `attachClient(c)` first):

```ts
it('attaches once per client', () => { expect(attachClient(c)).toBe(true); expect(attachClient(c)).toBe(false); expect(c.listenerCount('commandStarted')).toBe(1); });
it('pairs a start with its success by requestId and records the mapped find', () => {
  run(c, 'find', { find: 'orders', filter: { s: 'x' } });
  expect(s.aggregator.swap().items[0]).toMatchObject({ model: 'orders', operation: 'find', collection: 'orders', count: 1, maxMs: 150 });
});
it('keys requestIds per client: the same id on two clients never cross-pairs', () => {
  // c1 start id 7 (find a); c2 start id 7 (find b); c2 succeed id 7; c1 succeed id 7 → two items, a and b, count 1 each
});
it('skips a command under the threshold and counts one at exactly the threshold', () => { /* durations 99 and 100 → one item, count 1 */ });
it('rounds a fractional duration to an integer millisecond', () => { /* 150.6 → maxMs 151 */ });
it('records a failed command at or over the threshold in the same signature', () => { /* success + failure of one shape → count 2 */ });
it('drops a pair whose connectionId disagrees', () => { /* endConnectionId 2 → no items */ });
it('ignores commands outside the allow-list and on admin, local and config, but not bulkWrite', () => {
  // hello/ping → nothing; find on admin → nothing; bulkWrite on admin with nsInfo shop.orders → an orders item
});
it('counts each distinct statement shape once per multi-statement event', () => {
  // update with 3 statements, 2 sharing a shape → 2 items, each count 1, each maxMs 150
});
it('adds a matched getMore to the counted find without a second occurrence', () => {
  run(c, 'find', { find: 'd', filter: {} }, { duration: 150, reply: { cursor: { id: { toString: () => '77' }, firstBatch: [] } } });
  run(c, 'getMore', { getMore: { toString: () => '77' }, collection: 'd' }, { duration: 200, reply: { cursor: { id: 0 } } });
  expect(s.aggregator.swap().items[0]).toMatchObject({ count: 1, totalMs: 350, maxMs: 350 });
  expect(clientStats(c)!.cursors).toBe(0);
});
it('counts a slow getMore on its own under the originating signature when the find was fast', () => { /* find 10 ms, getMore 150 → item count 1, maxMs 150, operation 'find' */ });
it('starts a new occurrence for a getMore after a flush', () => { /* find 150, swap, getMore 150 → new window count 1, maxMs 150 */ });
it('forgets a cursor on killCursors', () => { /* killCursors { killCursors: 'd', cursors: [id] } → cursors 0 */ });
it('bounds the in-flight map at 2000 entries and 10 minutes', () => {
  vi.useFakeTimers();
  for (let i = 0; i < MAX_IN_FLIGHT + 1; i++) c.emit('commandStarted', { requestId: 10_000 + i, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'x', filter: {} } });
  expect(clientStats(c)!.inFlight).toBe(MAX_IN_FLIGHT);
  vi.advanceTimersByTime(MAX_IN_FLIGHT_AGE_MS + 1);
  c.emit('commandStarted', { requestId: 1, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'x', filter: {} } });
  expect(clientStats(c)!.inFlight).toBe(1);
});
it('bounds the cursor map at 2000 entries and 10 minutes idle', () => { /* 2001 live finds → 2000; advance; one more → 1 */ });
it('never lets an internal failure escape into the driver', () => {
  vi.spyOn(s.aggregator, 'add').mockImplementation(() => { throw new Error('boom'); });
  expect(() => run(c, 'find', { find: 'o', filter: {} })).not.toThrow();
  expect((s.onError as Mock).mock.calls[0]![0].message).toBe('boom');
});
it('does nothing while disabled or with no sink', () => { /* isDisabled → no items and inFlight 0; setSink(null) → same */ });
it('hands the raw (unredacted) sample input to the aggregator only when capture is on', () => {
  // for capture of [true, false]: spy add; run find { filter: { a: 1 } } → args[2] { filter: { a: '<number>' } }, args[3] capture ? { filter: { a: 1 } } : undefined
});
it('a command object mutated after the reply does not change the captured sample', () => {
  // captureRawSample true; aggregate [{ $match: { region: 'IN' } }]; mutate after the end → sampleText '{"pipeline":[{"$match":{"region":"IN"}}]}'
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/monitor.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `monitor.ts`** as specified. Per-client state lives in a `WeakMap<object, ClientState>`, which `clientStats` reads.

- [ ] **Step 4: Run to verify they pass** (the same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/monitor.ts packages/sdk/src/monitor.test.ts
git commit -m "feat(sdk): pair driver command events per client and attribute getMore to its cursor"
```

---

### Task 7: SDK — driver plumbing: peers, the connect wrap, monitoring detection

**Files:**
- Create: `packages/sdk/src/drivers.ts`, `packages/sdk/src/drivers.test.ts`

**Interfaces:**
- Consumes: `attachClient`, `currentSink` (Task 6).
- Produces:

```ts
/** Any MongoClient from driver 3–7. Structural on purpose: every check is made at runtime. */
export type MongoClientLike = object;
export const CONNECT_WRAP: unique symbol;  // Symbol.for('query-analyser.connect-wrap'), on the prototype: { original, wrapper, hadOwn }
export const MONITORING_OFF_WARNING: string; // the verbatim Global Constraints copy
/** Module-relative createRequire (__filename, then import.meta.url), then cwd; null when not installed. Moved from resolveMongoose. */
export function resolvePeer(name: string): unknown | null;
/** Read before anything touches the setter: 'on' if client.options.monitorCommands === true;
 *  'off' if a monitorCommands setter exists on the prototype chain; else 'unknown' (driver 3). */
export function monitorState(client: object): 'on' | 'off' | 'unknown';
/** Sets client.monitorCommands = true when a setter exists; otherwise does nothing. Never throws. */
export function enableMonitoring(client: object): void;
/** Wraps MongoClient.prototype.connect once. True when it was newly wrapped now. */
export function installConnectWrap(MongoClient: unknown): boolean;
/** For each prototype this module wrapped: restore the original if its wrapper is still on top (delete the own property if connect was inherited); otherwise leave the wrapper as a pass-through. */
export function undoConnectWraps(): void;
/** getClient?.() ?? client for each of mongoose.connections; falsy clients and throwing getters skipped; deduplicated. */
export function mongooseClients(mongoose: object): object[];
```

- **The wrapper:** `function connect(this: object, ...args: unknown[]) { if (currentSink()) try { enableMonitoring(this); attachClient(this); } catch { /* report via sink */ } return original.apply(this, args); }`, defined with `name: 'connect'`.
- **Idempotence:** if the prototype already has `CONNECT_WRAP`, don't wrap again; return `false`.

- [ ] **Step 1: Write the failing tests**

Fakes:

```ts
class Fake4 extends EventEmitter {
  options = { monitorCommands: false };
  result = Promise.resolve(this);
  seenAtConnect?: boolean;
  get monitorCommands() { return this.options.monitorCommands; }
  set monitorCommands(v: boolean) { this.options.monitorCommands = v; }
  connect(cb?: (e?: Error) => void) { this.seenAtConnect = this.options.monitorCommands; if (cb) { cb(); return undefined; } return this.result; }
}
class Fake3 extends EventEmitter { connect() { return Promise.resolve(this); } }
beforeEach(() => setSink(fakeSink())); afterEach(() => { undoConnectWraps(); setSink(null); });
```

Each test defines its fake classes inside the test, so prototypes are fresh.

```ts
it('sets monitorCommands and attaches before the original connect runs, and returns its value', () => {
  installConnectWrap(Fake4); const c = new Fake4();
  expect(c.connect()).toBe(c.result);
  expect(c.seenAtConnect).toBe(true);
  expect(c.listenerCount('commandStarted')).toBe(1);
});
it('passes a callback through untouched', () => { /* cb called once; return undefined */ });
it('is idempotent: wrapping twice wraps once', () => { /* second call false; Fake4.prototype.connect identical */ });
it('never throws into connect when preparing fails', () => { /* setter throws → connect still returns result */ });
it('is a pass-through when no analyser is active', () => { /* setSink(null) → seenAtConnect false, no listeners */ });
it('undo restores the original when the wrapper is still on top', () => { /* prototype.connect === original; no CONNECT_WRAP */ });
it('undo deletes the own property when connect was inherited', () => { /* class Sub extends Fake4 {}; wrap Sub; undo → !hasOwn(Sub.prototype,'connect') */ });
it('leaves a library wrapper added on top in place and becomes a pass-through', () => {
  installConnectWrap(Fake4);
  const ours = Fake4.prototype.connect; const apm = vi.fn(function (this: Fake4, ...a: unknown[]) { return ours.apply(this, a as []); });
  Fake4.prototype.connect = apm as never;
  undoConnectWraps();
  expect(Fake4.prototype.connect).toBe(apm);
  const c = new Fake4(); expect(c.connect()).toBe(c.result); expect(apm).toHaveBeenCalled(); expect(c.listenerCount('commandStarted')).toBe(0);
});
it('wraps over a library wrapper installed first and keeps calling it', () => { /* apm first, then installConnectWrap → apm still called; undo restores apm */ });
it('monitorState reads on/off before the setter is touched, and unknown on driver 3', () => {
  expect(monitorState(Object.assign(new Fake4(), { options: { monitorCommands: true } }))).toBe('on');
  expect(monitorState(new Fake4())).toBe('off');
  expect(monitorState(new Fake3())).toBe('unknown');
});
it('enableMonitoring sets the 4+ setter and leaves driver 3 alone', () => { /* Fake4 → true; Fake3 → no 'monitorCommands' own prop */ });
it('resolvePeer finds the SDK devDependencies and returns null for a missing package', () => {
  expect((resolvePeer('mongoose') as { version: string }).version).toMatch(/^8\./);
  expect(resolvePeer('qa-not-installed-pkg')).toBeNull();
});
it('mongooseClients collects every connection client, skipping missing ones and throwing getters', () => { /* 3 conns: client, none, throwing → [client] */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/drivers.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `drivers.ts`.** Move the three-strategy resolution body of `resolveMongoose` here, generalised to `name`. Track wrapped prototypes in a module-level `Set` for `undoConnectWraps`.

- [ ] **Step 4: Run to verify they pass** (the same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/drivers.ts packages/sdk/src/drivers.test.ts
git commit -m "feat(sdk): wrap MongoClient connect to switch on command monitoring"
```

---

### Task 8: SDK — `init()`, `instrument()` and `shutdown()` on the driver layer; remove the middleware hook

**Files:**
- Modify: `packages/sdk/src/index.ts`, `packages/sdk/package.json`, `packages/sdk/tsup.config.ts`
- Delete: `packages/sdk/src/hooks.ts`, `packages/sdk/src/hooks.test.ts`, `packages/sdk/src/__tests__/golden-record.test.ts`
- Create: `packages/sdk/src/init-unresolved.test.ts`
- Test: `packages/sdk/src/index.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces:
  - `InitOptions.mongoose?: object` (was `MongooseLike`), and `InitOptions.mongoClient?: MongoClientLike | MongoClientLike[]`;
  - `export function instrument(client: MongoClientLike): void` (never throws; works before or after `init()`);
  - `export type { MongoClientLike }`;
  - `export default { init, shutdown, instrument }`.
- `init()` after today's validation and the `enabled: false` early return:
  1. build the `MonitorSink` (`resolveModel` from `createModelResolver(mg)`) and call `setSink`;
  2. `mg = options.mongoose ?? resolvePeer('mongoose')`, `drv = resolvePeer('mongodb')`;
  3. call `installConnectWrap` for each distinct one of `drv?.MongoClient` and `mg?.mongo?.MongoClient`;
  4. call `watchClient` on each of `mongooseClients(mg)` and each `mongoClient`;
  5. if `!mg && !drv` and no `mongoClient` was given, report the unresolved warning;
  6. set `installedModels = resolver.modelCount()`.
- `watchClient(client, report)` (internal):
  - `if (monitorState(client) === 'off' && !warned.has(client)) { warned.add(client); report(new Error(MONITORING_OFF_WARNING)); }`
  - then `enableMonitoring(client); attachClient(client);`
  - all inside `try`/`catch`.
  - `warned` is a module-level `WeakSet`. `instrument()` reports through `currentSink()?.onError`, or through the default stderr writer when there is no sink.
- `shutdown()`: after the two flushes, if `currentSink()` is this analyser's sink, call `setSink(null)` and then `undoConnectWraps()`.
- `package.json`: the peer ranges and `peerDependenciesMeta` from Global Constraints, and the devDependency `"mongodb": "^6.20.0"`. `tsup.config.ts`: `external: ['mongoose', 'mongodb']`.
- Remove `reapplyPreCompiledHooks`, `CURRENT_CTX`, `PLUGIN_REGISTERED`, `MongooseWithState`, `PreCompiledModel` and their comments.

- [ ] **Step 1: Write the failing tests**

In `index.test.ts`, replace or keep each removed-middleware test as follows:

| Removed | Replaced by |
|---|---|
| `hooks.test` "installs only once per schema" | `monitor.test` "attaches once per client" (Task 6) |
| `hooks.test` "never lets an internal failure escape into the query" | `monitor.test` "never lets an internal failure escape into the driver" |
| `hooks.test` "hands the raw (unredacted) sample input…" | `monitor.test`, the same name |
| `hooks.test` "an aggregate pipeline mutated after the query…" | `monitor.test` "a command object mutated after the reply…" |
| `hooks.test` "skips the aggregator entirely once disabled" | `monitor.test` "does nothing while disabled or with no sink" |
| "instruments models compiled AFTER init via the global plugin" | "resolves a model registered after init()" (below) |
| "never throws when mongoose.models is a throwing getter…" | "never throws when mongoose.connections is a throwing getter, and still returns a usable Analyser" |
| "instruments the other models when one model schema throws during install" | `model-registry.test` "skips a model whose collection getter throws…" (Task 4) |
| "warns once when mongoose is resolved but zero models end up instrumented" | `init-unresolved.test` "warns once when neither…" (below) |
| "instruments models compiled BEFORE init was called" | kept: `installedModels` > 0 is now the registry count |

New tests in `index.test.ts`. `fakeClient()` is the `FakeClient` from Task 6, and `emitFind(c, coll, filter)` emits a paired start and success of 150 ms.

```ts
it('wraps connect of the resolved mongodb and of mongoose.mongo, and shutdown() restores it', async () => {
  init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
  expect(CONNECT_WRAP in mongoose.mongo.MongoClient.prototype).toBe(true);
  expect(CONNECT_WRAP in (resolvePeer('mongodb') as typeof mongoose.mongo).MongoClient.prototype).toBe(true);
  await shutdown();
  expect(CONNECT_WRAP in mongoose.mongo.MongoClient.prototype).toBe(false);
});
it('resolves a model registered after init()', async () => {
  const c = fakeClient(); const fetchImpl = vi.fn(okFetch);
  const a = init({ apiKey: 'k', app: 'x', mongoose, mongoClient: c, fetchImpl });
  const M = mongoose.model(`Late_${Date.now()}`, new mongoose.Schema({ a: Number }));
  emitFind(c, M.collection.collectionName, { a: 1 });   // databaseName = M.db.name
  await a.flush();
  expect(sentItems(fetchImpl)[0]).toMatchObject({ model: M.modelName, collection: M.collection.collectionName });
});
it('warns once, naming monitorCommands: true, for a mongoClient whose monitoring is off', () => {
  const onError = vi.fn(); const c = new Fake4();  // Task 7's fake: options.monitorCommands false plus a 4+ setter (monitorState 'off')
  init({ apiKey: 'k', app: 'x', mongoose, mongoClient: [c, c], fetchImpl: okFetch, onError });
  expect(onError.mock.calls.filter(([e]) => e.message === MONITORING_OFF_WARNING)).toHaveLength(1);
  expect(MONITORING_OFF_WARNING).toContain('`monitorCommands: true`');
  expect(MONITORING_OFF_WARNING).toContain('if this client was already connected');
});
it('instrument() on the same client on every invocation attaches once and warns at most once', async () => {
  // init; for 5 iterations instrument(c) → listenerCount('commandSucceeded') 1; one warning; emitFind once → count 1
});
it('instrument() captures a client from a driver copy the SDK cannot reach', async () => {
  // plain EventEmitter client with options.monitorCommands true (no prototype wrap) → instrument(c); emitFind → one item, model = collection
});
it('instrument() before init() is picked up once init() runs', async () => { /* instrument(c); init; emitFind → one item */ });
it('never throws when mongoose.connections is a throwing getter, and still returns a usable Analyser', () => {
  const fake = { get connections(): never { throw new Error('boom'); } };
  expect(() => init({ apiKey: 'k', app: 'x', mongoose: fake, fetchImpl: okFetch, onError: vi.fn() })).not.toThrow();
});
it('the default export carries init, shutdown and instrument', () =>
  expect(Object.keys(sdkDefault).sort()).toEqual(['init', 'instrument', 'shutdown']));
```

`init-unresolved.test.ts`:

```ts
vi.mock('./drivers.js', async (orig) => ({ ...(await orig<typeof import('./drivers.js')>()), resolvePeer: () => null }));
it('warns once when neither mongoose nor mongodb can be resolved and no mongoClient is given', () => {
  const onError = vi.fn();
  init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0]![0].message).toBe('query-analyser: neither mongoose nor mongodb could be resolved and no mongoClient was given; pass init({ mongoose }) or init({ mongoClient })');
});
it('does not warn when a mongoClient is given', () => { /* onError not called */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser install && pnpm --filter @vivekumar08/query-analyser exec vitest run src/index.test.ts src/init-unresolved.test.ts`
Expected: FAIL. `instrument` and `CONNECT_WRAP` aren't wired, and there is no warning.

- [ ] **Step 3: Implement** the `init()`, `watchClient`, `instrument()` and `shutdown()` changes above. Delete `hooks.ts`, `hooks.test.ts` and `golden-record.test.ts`, then edit `package.json` and `tsup.config.ts`.

- [ ] **Step 4: Run the SDK suite and the build**

Run: `pnpm --filter @vivekumar08/query-analyser test && pnpm --filter @vivekumar08/query-analyser typecheck && pnpm --filter @vivekumar08/query-analyser build && grep -c "require(\"mongo" packages/sdk/dist/index.cjs`
Expected: tests and typecheck pass and the build succeeds. The `grep` prints `0`: no static `require` of either peer.

The integration test is rewritten in Task 9. If its old `beforeAll` (connect before `init()`, no `monitorCommands`) now captures nothing, that is expected: mark that file `describe.skip` in this commit, with the comment `// rewritten in Task 9`, and nothing else.

- [ ] **Step 5: Commit**

```bash
git add -A packages/sdk pnpm-lock.yaml
git commit -m "feat(sdk): capture queries from driver command monitoring instead of mongoose middleware"
```

---

### Task 9: SDK — real-mongod integration and the 0.2 golden test

**Files:**
- Modify: `packages/sdk/src/__tests__/integration.test.ts`
- Create: `packages/sdk/src/__tests__/golden.test.ts`

**Interfaces:**
- Consumes: `golden-cases.ts` and `golden-0.2.json` (Task 1); `init`, `instrument`, `shutdown`, `MONITORING_OFF_WARNING`.

- [ ] **Step 1: Write the golden test**

`'all 35 mongoose 8 golden cases keep 0.2's exact hash, shape and sample'`:
1. start mongod;
2. call `init({ apiKey: 'k', app: 'golden', thresholdMs: 0, mongoose, fetchImpl })` **before** `mongoose.createConnection(uri).asPromise()`;
3. build and seed the models, then flush and discard;
4. for each case, run it, flush, and `expect(items.map(pick(GOLDEN_FIELDS))).toEqual([fixture.cases[name]])`;
5. finally, `expect(Object.keys(fixture.cases)).toHaveLength(35)`.

A failure names the case (`it.each` over `GOLDEN_CASES` inside one `describe`, sharing the connection).

- [ ] **Step 2: Rewrite the integration file**

Remove the `describe.skip`. `beforeAll` now runs `mongoose.connect(uri, { monitorCommands: true })`, the documented path for an app that connects before `init()`. Every existing test keeps its name and assertions. Add:

```ts
it('zero-setup: a connection opened after init() is captured with no options', async () => {
  // init → conn = createConnection(uri).asPromise() → conn.model(...).find(...) → item with model name and collection
});
it('warns once, naming monitorCommands: true, for a connection opened before init() without it, and captures nothing from it', async () => {
  // conn opened first; init({ onError }) → exactly one MONITORING_OFF_WARNING; its find → flush sends no item; conn.close()
});
it('captures the raw driver: a MongoClient from the app\'s own mongodb is captured under the collection name', async () => {
  // init → new MongoClient(uri) → connect → db('rawdb').collection('orders').find({ status: 'x' }).toArray() → { model: 'orders', collection: 'orders', source: 'mongodb' }
});
it('useDb() models resolve through otherDbs even when another db uses the same collection name', async () => {
  // default conn: IntA (collection shared_x); useDb('tenant_x'): IntB (collection shared_x) → items model IntA and IntB
});
it('two connections to different dbs resolve each model on the same collection name', async () => { /* IntOrderA / IntOrderB */ });
it('a cursor read in batches is one find occurrence, with no getMore item', async () => {
  // insertMany 300 docs; find({}).batchSize(10).toArray() → exactly one find item, count 1
});
it('a failed command at the threshold is counted and still rejects in the app', async () => {
  // unique index; duplicate insertOne → rejects with code 11000; flush → insert item count ≥ 1
});
it('captures insert, save(), collection bulkWrite statements and Model.collection queries', async () => {
  // create → insert; doc.save() after a change → updateOne(_id:eq); bulkWrite([insertOne, updateOne, deleteMany]) → insert, updateOne, deleteMany; Model.collection.find({a:1}).toArray() → find
});
it('never puts a queried value in the payload, for every captured command type', async () => {
  // a unique secret per call: find, findOne, countDocuments, distinct, updateOne, updateMany, replaceOne, deleteOne, deleteMany,
  // findOneAndUpdate, findOneAndDelete, findOneAndReplace, aggregate with $match and a $lookup sub-pipeline, insertOne, insertMany, bulkWrite
  // body contains none of the secrets, nor 'lsid', '$clusterTime', '"$db"', 'firstBatch'; it still contains the key names
  // ingestPayloadSchema.parse(body) succeeds
});
```

- [ ] **Step 3: Run**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/__tests__`
Expected: PASS: 35 golden cases plus every integration test. Any golden mismatch is a mapping bug: fix `command-map.ts`, never the fixture.

- [ ] **Step 4: Run the whole SDK suite**

Run: `pnpm --filter @vivekumar08/query-analyser test && pnpm --filter @vivekumar08/query-analyser typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/__tests__
git commit -m "test(sdk): driver capture against a real mongod, and 0.2 hash stability"
```

---

### Task 10: API — store and return each signature's `source` and `collection`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`QuerySignature`)
- Create: `apps/api/prisma/migrations/<timestamp>_signature_source_collection/migration.sql`
- Modify: `apps/api/src/ingest/writer.ts`, `apps/api/src/analysis/routes.ts` (`GET /v1/apps/:id/queries/:sig`)
- Test: `apps/api/src/ingest/writer.test.ts`, `apps/api/src/ingest/routes.test.ts`, `apps/api/src/analysis/routes.test.ts`

**Interfaces:**
- Consumes: `IngestItem.source?` and `collection?` (Task 2).
- Produces:
  - `QuerySignature.source String?` and `QuerySignature.collection String?`;
  - the detail JSON gains `source: string` (a stored null becomes `'mongodb'`) and `collection: string | null`.
- Writer:
  - `sigRows` add `source: i.source ?? null` and `collection: i.collection ?? null`;
  - the INSERT column list and the `jsonb_to_recordset` types add `source text, collection text`;
  - `ON CONFLICT` adds `"source" = COALESCE("QuerySignature"."source", EXCLUDED."source")` and the same for `"collection"`.

- [ ] **Step 1: Write the failing tests**

`writer.test.ts`:

```ts
describe('source and collection', () => {
  it('stores both on a new signature', async () => { /* item({ source: 'mongodb', collection: 'orders' }) → row source 'mongodb', collection 'orders' */ });
  it('stores null for a 0.1/0.2 item without them', async () => { /* item() → both null */ });
  it('fills a null collection on an existing signature and never overwrites a stored one', async () => {
    // write item() → null; write item({ collection: 'orders', source: 'mongodb' }) → 'orders'; write item({ collection: 'other' }) → still 'orders'
  });
});
```

`ingest/routes.test.ts`: `'accepts a 0.3 batch with source and collection and stores them'` (202, and the row has both).

`analysis/routes.test.ts`: `'detail returns source and collection, reading a null source as mongodb'`. The seeded signature has nulls, so expect `source: 'mongodb', collection: null`. After `update({ data: { source: 'mongodb', collection: 'users' } })`, expect `collection: 'users'`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/api db:generate && pnpm --filter @query-analyser/api exec vitest run src/ingest/writer.test.ts src/ingest/routes.test.ts src/analysis/routes.test.ts`
Expected: FAIL. The columns are unknown and the detail fields are missing.

- [ ] **Step 3: Schema and migration**

Add both fields to `QuerySignature`, each with `///` doc comments (`source`: "null reads as mongodb"; `collection`: "the real collection name, null from SDKs before 0.3").

Run: `pnpm --filter @query-analyser/api exec prisma migrate dev --create-only --name signature_source_collection`
Expected: a `migration.sql` with exactly `ALTER TABLE "QuerySignature" ADD COLUMN "collection" TEXT, ADD COLUMN "source" TEXT;`. Additive only.

Run: `pnpm --filter @query-analyser/api exec prisma migrate dev && pnpm --filter @query-analyser/api db:generate`
Expected: the migration applies.

- [ ] **Step 4: Implement the writer and the detail route changes above.**

- [ ] **Step 5: Run the API suite**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api typecheck`
Expected: all pass, including `ingest/e2e.test.ts`, which still ingests through the published SDK 0.1 and so pins 0.1 compatibility.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/src
git commit -m "feat(api): store each signature's source and collection"
```

---

### Task 11: Web — the Compass command uses the stored collection

**Files:**
- Modify: `apps/web/src/dashboard-types.ts` (`QueryDetail`), `apps/web/components/dashboard/CompassQuery.tsx`, `apps/web/app/dashboard/[org]/[app]/queries/[sig]/page.tsx`
- Test: `apps/web/components/dashboard/CompassQuery.test.tsx`

**Interfaces:**
- Consumes: the detail JSON from Task 10.
- Produces:
  - `QueryDetail` gains `source?: string` and `collection?: string | null`. They are optional so an API that hasn't been redeployed still type-matches.
  - `CompassQuery` gains the prop `collection?: string | null`, and its initial state is `collection || defaultCollection(model)`.
  - The page passes `collection={d.collection ?? null}`.

- [ ] **Step 1: Write the failing tests**

```ts
it('uses the stored collection name when present', () => {
  render(<CompassQuery {...base} collection="cat_items" encryptedSample={null} sampleKeyEnabled={false} canManage={false} />);
  expect(screen.getByText(/db\.getCollection\("cat_items"\)\.find/)).toBeTruthy();
  expect((screen.getByLabelText('Collection') as HTMLInputElement).value).toBe('cat_items');
});
it('falls back to the lowercase-plural guess when the collection is null', () => {
  render(<CompassQuery {...base} collection={null} encryptedSample={null} sampleKeyEnabled={false} canManage={false} />);
  expect(screen.getByText(/db\.getCollection\("categories"\)/)).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run components/dashboard/CompassQuery.test.tsx`
Expected: FAIL. The first test gets `categories`.

- [ ] **Step 3: Implement** the type, the prop and the page change.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/dashboard-types.ts apps/web/components/dashboard "apps/web/app/dashboard/[org]/[app]/queries/[sig]/page.tsx"
git commit -m "feat(web): compass command uses the stored collection name"
```

---

## Phase 3: compatibility and regression tests

### Task 12: Compat — every driver major and every Mongoose major on a real mongod

**Files:**
- Create: `packages/sdk-compat/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/sdk-compat/src/harness.ts`, `src/drivers.test.ts`, `src/mongoose.test.ts`, `src/mongoose5.test.ts`

**Interfaces:**
- Consumes: the SDK source through relative imports (`../../sdk/src/index.js`, `../../sdk/src/drivers.js`), not the package name. The root `pnpm.overrides` pins `@vivekumar08/query-analyser` to 0.1.0.
- Produces:
  - `package.json`: name `@query-analyser/sdk-compat`, `private: true`, `type: module`. Scripts: `test: vitest run`, `typecheck: tsc --noEmit`, `bench: QA_BENCH=1 vitest run src/overhead.test.ts`. devDependencies:
    - `@query-analyser/contract: workspace:*`, `@types/node: ^22.0.0`, `mongodb-memory-server: ^10.1.2`, `typescript: ^5.7.2`, `vitest: ^2.1.8`;
    - `mongodb4: npm:mongodb@4.17.2`, `mongodb5: npm:mongodb@5.9.2`, `mongodb6: npm:mongodb@6.22.0`, `mongodb7: npm:mongodb@7.8.0`;
    - `mongoose5: npm:mongoose@5.13.23`, `mongoose6: npm:mongoose@6.13.12`, `mongoose7: npm:mongoose@7.8.13`, `mongoose8: npm:mongoose@8.24.8`, `mongoose9: npm:mongoose@9.11.4`.
  - `vitest.config.ts`: mirror the SDK's `define: { __SDK_VERSION__ }` (read from `../sdk/package.json`), with `include: ['src/**/*.test.ts']`, `testTimeout: 120_000` and `fileParallelism: false`.
  - `tsconfig.json`: extends the base, `include: ['src']`, `types: ['node']`.
  - `harness.ts`:
    - `startMongo(version?: string): Promise<MongoMemoryServer>`;
    - `capture(): { fetchImpl: typeof fetch; items(): SentItem[]; bodies: string[] }` (gzip-aware, as in the SDK integration test);
    - `DRIVERS: { major: 4 | 5 | 6 | 7; mod: typeof import('mongodb7') }[]`;
    - `MONGOOSES: { major: 6 | 7 | 8 | 9; mod: typeof import('mongoose8') }[]`.

- [ ] **Step 1: Scaffold and install**

Run: `pnpm install && pnpm --filter @query-analyser/sdk-compat typecheck`
Expected: install succeeds and typecheck passes on an empty `harness.ts`. That includes `init({ apiKey: 'k', app: 'x', mongoClient: new mongodb7.MongoClient('mongodb://x') })` and `init({ apiKey: 'k', app: 'x', mongoose: mongoose9 })` written as type-only checks.

- [ ] **Step 2: Write `drivers.test.ts`**

It runs `describe.each(DRIVERS)('mongodb %i', …)`. Each test calls `init({ thresholdMs: 0, fetchImpl, onError })` and then `installConnectWrap(mod.MongoClient)`, because the aliased copy isn't the one `init()` resolves.

```ts
it('captures every command in the table under 0.2-style names', async () => {
  // find, findOne, aggregate, countDocuments, distinct, updateOne, updateMany, replaceOne, deleteOne, deleteMany,
  // findOneAndUpdate, findOneAndDelete, findOneAndReplace, insertOne, estimatedDocumentCount
  expect(new Set(items().map((i) => i.operation))).toEqual(new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct',
    'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'insert', 'count']));
});
it('zero-setup: an explicit connect() after init() is captured with no options', …);
it('zero-setup: auto-connect on the first operation is captured too', …);
it('a client connected before the SDK saw it warns once and captures nothing', async () => {
  // connect, then instrument(client) twice → one MONITORING_OFF_WARNING; a find → no items
});
it('pairs 50 concurrent finds of two shapes correctly', …);          // counts 25 and 25
it('a cursor read in batches of 10 is one find occurrence', …);       // 300 docs; one find item, count 1
it('a failed insert is counted and still rejects', …);                // duplicate key: code 11000, insert count 1
it('never puts a queried value in the payload for any command', …);   // the Task 9 assertion, raw driver
describe.runIf(major >= 6)('MongoClient.bulkWrite (mongod 8.0.4)', () => {
  it('is captured per statement despite running on the admin db', …); // operations insert, updateMany, deleteOne on collection 'orders'
});
```

- [ ] **Step 3: Write `mongoose.test.ts`**

It runs `describe.each(MONGOOSES)('mongoose %i', …)`. Each test calls `init({ mongoose: mod, thresholdMs: 0, fetchImpl })` before `mod.connect(uri)`.

```ts
it('zero-setup: init() before connect() captures Model queries under the model name', …);
it('a connection created later with createConnection() is captured', …);
it('useDb() models resolve to their own model name', …);
it('a discriminator query resolves to the discriminator, keeping __t in the shape', …); // filterShape contains { key: '__t', op: 'eq' }
it('a cursor read in batches is one occurrence', …);
it('a failed command is counted and still rejects in the app', …);
it('never puts a queried value in the payload', …);
it('save, find, update, delete, aggregate, insertMany and bulkWrite never throw into app code', …); // all resolve
```

Then a separate `describe('mongoose 9')` with `it('never throws into app code where 0.2 threw "next is not a function"', …)`. It uses a schema with `pre('save', async function () {})` and `pre('find', function () {})` hooks of its own, runs `save`, `find`, `findOne`, `updateOne`, `deleteOne`, `aggregate`, `countDocuments` and `insertMany` with the SDK active, and expects each to resolve and the items to include `find` and `insert`.

- [ ] **Step 4: Write `mongoose5.test.ts`**

It holds one smoke test, `'mongoose 5 with monitorCommands: true reports a find under its model name'`:
1. `init({ mongoose: mongoose5, thresholdMs: 0, fetchImpl })`;
2. `mongoose5.connect(uri, { monitorCommands: true, useNewUrlParser: true, useUnifiedTopology: true })`;
3. `Smoke.find({ a: 1 })`;
4. expect an item matching `{ model: 'Smoke', operation: 'find', collection: 'smokes' }`.

The file's header comment states that Mongoose 5 is best effort, with no guarantee beyond this test.

- [ ] **Step 5: Run**

Run: `pnpm --filter @query-analyser/contract build && pnpm --filter @query-analyser/sdk-compat test && pnpm --filter @query-analyser/sdk-compat typecheck`
Expected: all pass (4 driver suites, 4 Mongoose suites plus the Mongoose 9 one, and the Mongoose 5 smoke test). A failure on one major is fixed in the SDK source, never by skipping that major.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-compat pnpm-lock.yaml
git commit -m "test(sdk): compatibility matrix for mongodb 4-7 and mongoose 5-9"
```

---

### Task 13: Compat — overhead benchmark

**Files:**
- Create: `packages/sdk-compat/src/overhead.test.ts`

**Interfaces:**
- Consumes: `harness.ts`, `init`, `shutdown`, `installConnectWrap`.
- Produces: a `console.table` with the columns `driver`, `workload`, `offMsPerOp`, `monitorOnlyMsPerOp`, `sdkMsPerOp`, `sdkAddedPct`. Task 15 copies it into the release notes.

- [ ] **Step 1: Write the benchmark**

`describe.runIf(process.env.QA_BENCH === '1')('overhead', …)` runs for `mongodb6` and `mongodb7`.
- Seed 20,000 documents of `{ i, s: 'x'.repeat(40), n: i % 7 }` once.
- Workloads:
  - `findOne by _id ×2000`;
  - `find 20k docs toArray ×30`;
  - `insertOne ×2000` (into a scratch collection that is dropped afterwards).
- Configurations, each on a fresh client:
  - `off`: no SDK, no `monitorCommands`;
  - `monitor-only`: `monitorCommands: true` with no listeners;
  - `sdk`: `init({ thresholdMs: 100 })` plus the wrap before `connect()`.
- Report the median of 5 runs, in ms per operation. There is no assertion beyond `expect(rows).toHaveLength(6)`; the spec sets no pass/fail number.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @query-analyser/sdk-compat bench`
Expected: 1 passed, and a 6-row table printed. The spike's figures for scale: a 20k `find` goes from 22.1 to 30.9 ms on driver 6 with monitoring on.

Run: `pnpm --filter @query-analyser/sdk-compat test`
Expected: the benchmark is skipped and everything else passes.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-compat/src/overhead.test.ts
git commit -m "test(sdk): benchmark the cost of command monitoring and the SDK"
```

---

## Phase 4: release prep

### Task 14: Web — supported versions in the copy, and the driver line in onboarding

**Files:**
- Modify: `apps/web/app/page.tsx:47`, `apps/web/components/onboarding/InstallStep.tsx` (the help list at `:192`, and the snippet block), `apps/web/components/onboarding/snippet.ts`
- Test: `apps/web/src/homepage.test.tsx`, `apps/web/src/snippet.test.ts`, `apps/web/components/onboarding/InstallStep.test.tsx`

**Interfaces:**
- Produces: `buildSnippet(key, appName): { install: string; code: string; driverCode: string }`.
  - `code` is today's snippet with a first line, `// Call this before your app connects to MongoDB.`
  - `driverCode` doesn't inline the key:

    ```
    // Using the mongodb driver directly? Pass your client too:
    const client = new MongoClient(process.env.MONGODB_URI, { monitorCommands: true });
    require('@vivekumar08/query-analyser').init({ apiKey: process.env.QA_KEY, app: <JSON app name>, mongoClient: client });
    ```
- Copy, verbatim:
  - the homepage eyebrow: `For MongoDB · Mongoose 6–9 · Node.js driver 4–7`;
  - the help items replacing "Your app uses mongoose 8.": `Your app uses Mongoose 6–9 or the MongoDB Node.js driver 4–7 (Mongoose 5 needs monitorCommands: true).` and `init() runs before your app connects to MongoDB, or the connection sets monitorCommands: true.`;
  - the snippet labels: `Mongoose` and `MongoDB driver`;
  - the second button: `Copy driver snippet`.
- The "MongoDB queries" email copy is unchanged.

- [ ] **Step 1: Write the failing tests**

- `homepage.test.tsx`: the eyebrow string becomes `'For MongoDB · Mongoose 6–9 · Node.js driver 4–7'`.
- `snippet.test.ts`:

```ts
it('the main snippet says to call it before connecting', () =>
  expect(buildSnippet('k', 'a').code.split('\n')[0]).toBe('// Call this before your app connects to MongoDB.'));
it('the driver snippet passes the client with monitorCommands and never inlines the key', () => {
  const s = buildSnippet('qa_live_abc', 'a"b');
  expect(s.driverCode).toContain('{ monitorCommands: true }');
  expect(s.driverCode).toContain('mongoClient: client');
  expect(s.driverCode).toContain('app: "a\\"b"');
  expect(s.driverCode).not.toContain('qa_live_abc');
});
```

- `InstallStep.test.tsx`: `'shows the mongoose and the driver snippet, each copyable'`. Expect the labels `Mongoose` and `MongoDB driver`, the text `/mongoClient: client/`, and a button named `Copy driver snippet`. The existing `getByText(/qa_secret/)` still finds exactly one match.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run src/homepage.test.tsx src/snippet.test.ts components/onboarding/InstallStep.test.tsx`
Expected: FAIL on the new copy.

- [ ] **Step 3: Implement.** The second `<pre>` sits under the first and has the same classes. Its copy button copies `${s.install}\n\n${s.driverCode}` and sets `copied`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web typecheck && pnpm --filter @query-analyser/web build && ! grep -rn "mongoose 8" apps/web/app apps/web/components`
Expected: all pass and `grep` finds nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/page.tsx apps/web/components/onboarding apps/web/src/homepage.test.tsx apps/web/src/snippet.test.ts
git commit -m "feat(web): name the supported mongoose and driver versions; driver snippet in onboarding"
```

---

### Task 15: SDK — prepare 0.3.0: version, README, changelog (no publish)

**Files:**
- Modify: `packages/sdk/package.json` (`"version": "0.3.0"`; `files` gains `"CHANGELOG.md"`), `packages/sdk/README.md`
- Create: `packages/sdk/CHANGELOG.md`

**Interfaces:**
- Consumes: Task 13's table. `SDK_VERSION` follows `package.json` (`'SDK_VERSION matches package.json'` already pins it).

- [ ] **Step 1: README**
  - **Setup:** "Call `init()` before your app connects to MongoDB (before `mongoose.connect()` or `client.connect()`)." Remove "Call `init()` anywhere…" and the "Requires `mongoose` `>=8 <9`… undocumented internals" paragraph.
  - **"Using the mongodb driver":** nothing to add when `init()` runs first. For a client created earlier, or from a bundled copy of the driver, connect it with `{ monitorCommands: true }` and pass `init({ …, mongoClient: client })` or call `instrument(client)`. Quote the warning text from Global Constraints and say what to do about it.
  - **Supported versions table** (from spike Q5):
    - `mongodb` 4–7 and Mongoose 6–9 are supported and tested;
    - Mongoose 5.13 is best effort and **requires** `monitorCommands: true` in the connect options, because the SDK can't switch monitoring on or detect it there.
  - **"Migrating from 0.2":**
    - nothing to do for Mongoose 8 users whose `init()` runs before connecting; otherwise add `monitorCommands: true`;
    - query hashes are unchanged, so history continues;
    - newly captured: `insert`, `save()`, `bulkWrite` statements, `Model.collection.*`, failed commands, and `estimatedDocumentCount` (which appears as `count`).
  - **"What leaves your process":** add `collection` and `source`.
  - **Options table:** add `mongoClient`.
  - **Notes:** replace "Nothing runs on the query path except a timestamp and a map write" with: the SDK listens to the driver's command events. Then add one sentence on the cost for large reads, linking to the changelog.
- [ ] **Step 2: `CHANGELOG.md`**, with a `## 0.3.0` section that states:
  - capture moved from Mongoose middleware to the driver's command monitoring, covering Mongoose 6–9, Mongoose 5.13 (best effort) and raw `mongodb` 4–7;
  - 0.2 threw `TypeError: next is not a function` into apps on Mongoose 9, and 0.3 doesn't;
  - **0.3 measures database time.** 0.2 also counted time in the app (casting, hydration, pool waits, `bufferCommands`), so latencies for the same shape can drop at the upgrade. Durations are still whole milliseconds. Make no precision claim;
  - all 35 tested Mongoose 8 query shapes keep their 0.2 hash, filter shape and sample, and the newly captured operations are listed;
  - **the cost of turning monitoring on,** with Task 13's table, stated plainly for large reads (the driver builds each reply for the event). There is no opt-out;
  - call `init()` before connecting, otherwise use `monitorCommands: true`;
  - items now carry `source` and `collection`. Older APIs ignore them; the dashboard uses `collection` for the Compass command.
- [ ] **Step 3: Verify the release candidate**

Run: `pnpm --filter @query-analyser/contract build && pnpm --filter @vivekumar08/query-analyser build && pnpm --filter @vivekumar08/query-analyser typecheck && pnpm --filter @vivekumar08/query-analyser test && cd packages/sdk && npm pack --dry-run && cd ../.. && grep -n "anywhere" packages/sdk/README.md`
Expected:
- everything passes;
- `npm pack --dry-run` lists `CHANGELOG.md`, `LICENSE`, `README.md`, `dist/index.cjs`, `dist/index.d.cts`, `dist/index.d.ts`, `dist/index.js` and `package.json`, with version `0.3.0`;
- `grep` prints nothing.

Then run the whole repo: `caffeinate -i pnpm test && pnpm typecheck`
Expected: all packages pass.

- [ ] **Step 4: Commit (do not publish)**

```bash
git add packages/sdk/package.json packages/sdk/README.md packages/sdk/CHANGELOG.md
git commit -m "chore(sdk): prepare 0.3.0: readme, changelog and version"
```

Publishing `@vivekumar08/query-analyser@0.3.0` waits for the user's go-ahead.
