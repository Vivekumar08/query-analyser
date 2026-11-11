# MongoDB driver monitoring: spike results

Date: 2026-10-25
Spec: `2026-10-23-mongodb-driver-monitoring-design.md`, "Phase 1: technical spike".
Branch: `feat/mongodb-driver-monitoring`. The spike code was throwaway and lived outside the repo.

## Setup

- Node v26.7.0. mongod 7.0.24 from the `~/.cache/mongodb-binaries` cache, run through `mongodb-memory-server` 11.3.0. mongod 8.0.4 was used for `MongoClient.bulkWrite` and for a second Mongoose 5 run. Every mongod was stopped afterwards (`pgrep mongod` found none left).
- Packages were installed side by side as npm aliases, with `--ignore-scripts`. Each Mongoose major ran on the driver it bundles.

| Alias | Version | Bundled driver |
|---|---|---|
| `mongodb3` / `4` / `5` / `6` / `7` | 3.7.4 / 4.17.2 / 5.9.2 / 6.22.0 / 7.8.0 | n/a |
| `mongoose5` | 5.13.23 (last release 2024-12-17) | 3.7.4 |
| `mongoose6` | 6.13.12 | 4.17.2 |
| `mongoose7` | 7.8.13 | 5.9.2 |
| `mongoose8` | 8.24.8 | 6.20.0 |
| `mongoose9` | 9.11.4 | 7.7.0 |

Driver 7 and Mongoose 9 both exist.

## Decisions in one place

1. **Monitoring cannot be turned on for a client that is already connected,** on any driver major. This contradicts the spec. The flag must be in place before the client connects.
2. **`requestId` is a reliable pairing key.** Key it per client. Tie a `getMore` to its cursor by cursor id, which works on every major.
3. **`duration` is integer milliseconds on every major.** It has the same 1 ms resolution as today's `Date.now()`.
4. **The registry map works,** with two additions: `useDb()` connections live in `conn.otherDbs`, not in `mongoose.connections`, and discriminators need the C2 rule.
5. **Hashes stay stable for all 35 Mongoose 8 query shapes tested,** provided the SDK applies four corrections to the spec's mapping (see Q6). The mapping belongs in the SDK.

## Q1. Monitoring initialisation

Script: `drv.js <driver>`, run as `node run.js drv.js mongodb4`, and so on for each major.

| Driver | `monitorCommands` setter | Setter after `connect()` | Setter before the first op | `monitorCommands: true` in options |
|---|---|---|---|---|
| 3.7.4 | none (assigning a plain property does nothing) | no events | no events | events |
| 4.17.2 | getter and setter | **no events** | events | events |
| 5.9.2 | getter and setter | **no events** | events | events |
| 6.22.0 | getter and setter | **no events** | events | events |
| 7.8.0 | getter and setter | **no events** | events | events |

Observed output (the same for 4–7):
```
[mongodb6@6.22.0] A3 after client.monitorCommands=true on connected client: user events = [] value now true
[mongodb6@6.22.0] B monitorCommands:true in options: user events = ["find"]
[mongodb6@6.22.0] C setter before first op (auto-connect): user events = ["find"]
```

- **Why the setter does nothing:** the setter only writes `client.options.monitorCommands`. Each `Connection` copies the flag when the topology is created (`cmap/connection.js`: `this.monitorCommands = options.monitorCommands`).
- **New pool connections don't pick it up either.** `setter2.js` set the flag on a connected client and then forced pool growth with 40 parallel slow finds: `find events = 0` on 4, 5, 6 and 7. Only `close()` followed by `connect()` picked it up (`find events = 1`), and the SDK must never do that to an app's client.
- **Detecting the setting (4+):** `client.options.monitorCommands` is public and reports whether the option was given: `true` with it, `false` without (`d4opt.js`). It turns `true` once anyone calls the setter, even though events stay off. So read it *before* the SDK touches the setter.
- **Detecting the setting (3.x):** driver 3 has no public `options`. The flag lives only in the internal `client.s.options`.
- **Auto-enable before connect works.** Wrapping the public `MongoClient.prototype.connect` to set `this.monitorCommands = true` turned events on:
  - for an explicit `connect()` on 4–7;
  - for driver auto-connect on the first operation on 4–7 (`autoconn.js`: `find events = 1`).

**Mongoose** (`mg.js <major>`, for majors 5–9):
- `connection.getClient()` and `connection.client` both exist on 5–9 and return the same `MongoClient`.
- Attaching listeners after `mongoose.connect()` resolves is fine, but only when monitoring was on at connect:
  - without the option: `M1 attach + setter after mongoose.connect(): find events = 0`, on every major;
  - with it: `M2 mongoose.connect(uri,{monitorCommands:true}), attach after: find events = 2`, on every major. Mongoose passes the option through to the driver.
- `mongoose.mongo` is the driver Mongoose itself uses (`true` on 5–9). Wrapping `mongoose.mongo.MongoClient.prototype.connect` before `mongoose.connect()` gave events on 5–9. Mongoose 5 needed the internal `this.s.options.monitorCommands`; 6–9 used the public setter.
- **Connections created later (`createConnection`):**
  - `mongoose.events` emits `createConnection` on 5–9, before the client exists (`client present at event false`). `mongoose.events` is not in Mongoose's TypeScript types.
  - Each such connection is a separate `MongoClient` (`distinct clients 2`). It needs its own `monitorCommands: true`, or the connect wrapper.
  - Listeners can be attached once `asPromise()` resolves or `connected` fires.
- **`useDb()`** shares its parent's client (`useDb shares client: true`), so no extra attach is needed.

**Decision for the plan (needs a controller ruling):** the spec's fallback, a documented option plus a warning, becomes the main path. The README's "Call `init()` anywhere" stops being true for driver capture. Proposed:
- **When `init()` runs before connect:** the SDK wraps `MongoClient.prototype.connect` of the driver it can reach, so clients that connect later are covered with no setup.
  - For Mongoose, that driver is `mongoose.mongo`.
  - For a raw `mongoClient` or `instrument(client)` that hasn't connected yet, setting `client.monitorCommands = true` is enough, as row C shows.
  - The wrapper patches a *public* driver method, not a Mongoose internal. It is still a patch, so the controller must rule on it.
- **For a client already connected without the option:** one warning naming `monitorCommands: true`. Detect this through `client.options.monitorCommands` on driver 4+. Driver 4+ has no public "is connected" flag (`MongoClient.prototype` members: `options, monitorCommands, connect, close, db, …`). So the warning should say "if this client was already connected" rather than claim it was.

## Q2. Event matching

`drv.js`, step D1: 50 parallel `find`s on a pool of 10.
```
[mongodb7@7.8.0] D1 50 parallel finds: started 50 succeeded 50 unique requestIds 50 unmatched 0 connId mismatch 0 reply-vs-filter mismatch 0 distinct connectionIds 9 ...
```
The same held on 3, 4, 5 and 6. Every reply's first batch matched the filter of the start event with the same `requestId`.
- **`requestId` is a number from a counter in each driver copy, shared by that copy's clients.** Observed: client1 `92`, client2 `94`. Two driver copies (an app's own `mongodb` and Mongoose's bundled one) count independently. So key the in-flight map per client: one map inside each client's listener closure, keyed by `requestId`.
- **`connectionId` is a small number,** unique only within one server's pool. It agrees between start and end (0 mismatches). Use it only as a cross-check.
- **Failures:** `commandFailed` carries the same `requestId` and `connectionId` as its start (`hasStartedPair: true`) and has a `duration`, on 3–7.

**Linking `getMore` to its cursor** (`drv.js`, step D3; identical on 3–7):
```
find        db spike collection: d | cmd cursor -                         | reply cursor.id 8993695120492748531 (Long) | reply ns spike.d
getMore     db spike collection: d | cmd cursor 8993695120492748531 (Long) | reply cursor.id 8993695120492748531 (Long)
getMore     db spike collection: d | cmd cursor 8993695120492748531 (Long) | reply cursor.id 0 (Number)
killCursors db spike collection: d | cmd cursor 8993695120492748531 (Long)
```
- Link by cursor id: when the `find` or `aggregate` succeeds, record `reply.cursor.id` (a `Long`). Each `getMore` start carries `command.getMore`, the same `Long`, and `command.collection`. Key the map by `databaseName` + collection + `cursorId.toString()`.
- Cursor ends:
  - the last `getMore` replies with `cursor.id` 0, a plain `Number`;
  - an early close sends `killCursors` with `command.cursors[0]`.
- `command.getMore` plus `collection` alone can't tell two cursors on the same collection apart. Use it only as part of the key.

**Where the db and collection names are:**

| Event | Database name | Collection name |
|---|---|---|
| `commandStarted` | `databaseName` (3–7) | `command[commandName]` (`find`, `aggregate`, `insert`, `update`, `delete`, `findAndModify`, `count`, `distinct`). `getMore` carries `command.collection`. A db-level `aggregate` has `command.aggregate === 1` (seen on 4/6/7 with `$documents`). |
| `commandSucceeded` / `commandFailed` | only on driver 6 and 7 | never: keep it from the start |
| cursor replies | `reply.cursor.ns` = `"db.coll"` | same |

## Q3. Duration

- Every major reports **integer milliseconds** (D2: `integers 50/50` on each major). A 120 ms server-side sleep measured `158 / 133 / 133 / 133 / 129` against a wall clock of `158.9 / 133.6 / 133.8 / 133.7 / 130.1` ms (drivers 3–7).
- Source:
  - 3.x, 4.x and 6.x: `Math.floor(hrtime ms)` at start and at end (`utils.js` `now()`);
  - 7.x: `Math.floor(performance.now())`.
  - Driver 5 was not read, but its output was also integers.
- Resolution is the same 1 ms as 0.2's `Date.now()`, and fast commands read as `0`. What changes is *what* is measured (database round trip only), not the precision. Keep the `>= thresholdMs` rule.

## Q4. Model resolution

Script: `models.js <major>`. Models:
- `User` on the default connection;
- `Thing` with explicit collection `my_things`;
- `Person` (pluralised to `people`);
- `Animal` with a `Dog` discriminator;
- `Event` and a second `User` on `createConnection('analytics')`;
- a third `User` on `useDb('tenant_a')`;
- `Late`, registered after the map's inputs existed.

Results on 5, 6, 7, 8 and 9 were identical:
```
useDb conn in mongoose.connections: false | default conn otherDbs has tenant: true
User → app/users OK · Thing → app/my_things OK · Person → app/people OK · Event → analytics/events OK
User(analytics) → analytics/users OK · User(tenant_a) → tenant_a/users OK (only when otherDbs is walked) · Late OK
Animal, Dog → app/animals → ["Animal","Dog"] NEEDS RULE   (Dog's driver filter: {"__t":"Dog","a":1})
```
- Keying by `(model.db.name, model.collection.collectionName)` is correct for explicit names, pluralised names, and two connections to different dbs, even with the same model name.
- `mongoose.models` covers only the default connection. Walk every entry of `mongoose.connections` and each one's `.models`.
- **`useDb()` connections are not in `mongoose.connections`.** They are in `conn.otherDbs`. That property is not in Mongoose's TypeScript types, and its source carries a `FIXME: To be replaced with relatedDbs` comment. Read it guarded, and fall back to the collection name alone when every registered model with that collection name has the same model name. That covers the usual multi-tenant case.
- **Discriminators:** apply C2. Use the discriminator's name when the filter's `discriminatorKey` value names a registered discriminator, otherwise the base model (the one without `baseModelName`).

## Q5. Supported versions

| Library | Majors | Status | Monitoring setup |
|---|---|---|---|
| `mongodb` driver | 4, 5, 6, 7 | supported, tested | automatic if the SDK sees the client before it connects; otherwise `monitorCommands: true` |
| Mongoose | 6, 7, 8, 9 | supported, tested | automatic if `init()` runs before `mongoose.connect()` (connect wrapper); otherwise `monitorCommands: true` in the connect options |
| Mongoose 5.13 / driver 3.7 | 5 | **in, best effort** | `monitorCommands: true` in the connect options is **required** |

**Mongoose 5 verdict: in, best effort.**
- Events fire with the option on mongod 7.0.24 and 8.0.4.
- The event shape is the same, without `serviceId`, and without `databaseName` on the end events.
- The op mapping gives the same names as on 8, except `estimatedDocumentCount` (see Q6).
- It is "best effort" for two reasons:
  - Without internals (`client.s.options`), the SDK can neither turn monitoring on nor tell whether it is on.
  - Upstream's last 5.x release was 2024-12-17.
- So the README states the option as mandatory for 5, and the SDK cannot warn reliably there. Suggested peer range: `mongoose >=5.13 <10`, optional, and `mongodb >=4 <8`, optional.

Side finding: SDK 0.2 on Mongoose 9 throws into app code (`TypeError: next is not a function`), because Mongoose 9 middleware no longer passes `next`. This is a further reason to remove the middleware hook.

## Q6. Hash stability and redaction

**What 0.2 captures.** `QUERY_OPS` plus `aggregate` (`hooks.ts`) fires, on Mongoose 8, for:
- `find`, `findOne`, `countDocuments`, `distinct`;
- `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`;
- `findOneAndUpdate`, `findOneAndDelete`, `findOneAndReplace`;
- `aggregate`.

Wrappers report the op they call: `findById` and `exists` as `findOne`, `findByIdAndUpdate` as `findOneAndUpdate`, `findByIdAndDelete` as `findOneAndDelete`, and `doc.deleteOne()` as `deleteOne`.

**Method.** `hash.js 8` ran each query through the real 0.2 build (`packages/sdk/dist/index.cjs`, `thresholdMs: 0`, capturing the payload). For the same query it took the driver `commandStarted` event, mapped it, and called the real `src/signature.ts` `buildSignature` and `src/redact.ts` `redact`.
```
hash SAME for 35/35 captured-by-0.2 cases   (filterShape, sortKeys and redacted sample also identical)
```
After diffing the mapped output of every other major against 8: 6, 7 and 9 were identical, and 5 differed only on `estimatedDocumentCount`.

| Mongoose call | Driver command | How the 0.2 name is rebuilt |
|---|---|---|
| `find` | `find` | default |
| `findOne`, `findById`, `exists` | `find` with `limit: 1, singleBatch: true` | → `findOne` |
| `find().limit(1)` | `find` with `limit: 1`, **no** `singleBatch` | stays `find`, as in 0.2 |
| `countDocuments` | `aggregate [$match, ($skip), ($limit), $group{_id:1,n:{$sum:1}}]` | → `countDocuments`, filter = `$match` |
| `distinct` | `distinct` | filter = `query` |
| `updateOne` / `updateMany` | `update`, statement without / with `multi: true` | `q` is the filter |
| `replaceOne` | `update`, statement whose `u` has no `$` keys and is not an array | → `replaceOne` |
| `deleteOne` / `deleteMany`, `doc.deleteOne()` | `delete` with `limit: 1` / `0` | `q` is the filter |
| `findOneAndUpdate`, `findByIdAndUpdate` | `findAndModify` whose `update` has `$` keys (or is a pipeline) | `query`, `sort` |
| `findOneAndReplace` | `findAndModify` whose `update` has no `$` keys | → `findOneAndReplace` |
| `findOneAndDelete`, `findByIdAndDelete` | `findAndModify` with `remove: true` | → `findOneAndDelete` |
| `aggregate` | `aggregate` | stages, as today |

**Four corrections the spec's C1 needs:**
1. **`countDocuments` with skip or limit** puts `$skip` and `$limit` between `$match` and `$group` (raw output: `[{"$match":{"a":1}},{"$skip":1},{"$limit":5},{"$group":{"_id":1,"n":{"$sum":1}}}]`). The rule must allow them, or those shapes change hash.
2. **`replaceOne` and `findOneAndReplace` can be detected** from the update document. Mongoose wraps a `$`-less `updateOne` in `$set` before it reaches the driver, so the test stays safe.
3. **Discriminators: 0.2 keeps the key in the shape.** It sent `Dog.find(__t:eq,name:eq)`. Dropping `__t` (spec C2) changed the hash in all 4 discriminator cases tested. Keep the key in the shape and only use it to pick the model name.
4. **`sort` reaches the driver as a `Map`** on 4–7, and also on Mongoose 5's driver 3 path (raw output: `sort: Map [["age",-1]]`). `normalizeSort` ignores a `Map`, and `redact` turns it into `"<Map>"`. Convert it with `Object.fromEntries` before both calls.

**Names that change, or that are new (none were captured by 0.2):**
- `estimatedDocumentCount` arrives as a `count` command on 4+, which gives `User.count()`. On driver 3 it arrives as `aggregate [$collStats, $group]`.
- `insert` comes from `save()` of a new doc, `create` and `insertMany`.
- `doc.save()` of a modified doc gives `updateOne(_id:eq)`.
- `bulkWrite` splits into one signature per statement.
- `Model.collection.*` is now captured too.

**Where the mapping lives: the SDK.** It needs `singleBatch`, `multi`, `limit`, `remove`, the update document and the pipeline. None of those may leave the process unredacted, so the API cannot rebuild them. No API aliasing is needed, because the 0.2 hashes reproduce exactly.

**Redaction: filter shape and sample are identical** when the SDK builds the same `{ filter, update?, sort? }` or `{ pipeline }` input that 0.2 built. Never pass the whole command. It contains `lsid`, `$clusterTime`, `$db` and other driver fields. Commands that need care:
- **`insert` `documents`:** every field is a real value, and a batch can hold thousands. Send no filter shape. If a sample is kept, it is a redacted shape only, bounded by `redact`'s 8-element and depth-5 limits.
- **`update` `u` and `findAndModify` `update`:** real values. They may also be a replacement document or an update pipeline (an array). Mongoose adds `updatedAt` / `$setOnInsert`, as 0.2 already saw.
- **`aggregate` `pipeline`:** values sit inside `$match`, `$lookup` sub-pipelines and `$documents`. Redact as today, and never log the pipeline.
- **`bulkWrite`:** the collection form reaches the driver as separate `insert`, `update` and `delete` commands. Each `update` or `delete` holds many statements.
- **`MongoClient.bulkWrite` (driver 6+, server 8.0+):** it is a single `bulkWrite` command on the `admin` db, with `ops` and `nsInfo` (`misc.js`, mongod 8.0.4). The spec's admin and allow-list rules drop it silently. Decide whether that is acceptable.
- **Succeeded `reply` objects** contain result documents (`firstBatch`). Read only `cursor.id` and `cursor.ns`, and keep nothing else.

**Overhead to benchmark in Phase 3.** Turning monitoring on with empty listeners made a 20k-document `find().toArray()` slower: 28.2 → 39.1 ms (driver 4), 22.1 → 30.9 ms (driver 6), 18.4 → 25.7 ms (driver 7). Small `findOne`s barely moved (`bench.js`, single run). The driver builds the reply object for the event, so this cost belongs to monitoring itself, not to the SDK code.

## Contradictions with the spec

1. **"Can monitoring be switched on for a client that is already connected?" No,** on every driver major. The `monitorCommands` setter exists on 4–7, but it has no effect once the client is connected, even for new pool connections. So the spec's fallback (the connect option plus a warning) is required whenever the SDK sees a client after it connected. The README's "Call `init()` anywhere" no longer holds. Wrapping `MongoClient.prototype.connect` at `init()` restores zero-setup for clients that connect later; the controller must rule on it.
2. **Timing precision:** the driver's `duration` is also integer milliseconds. The gain is excluding app time, not a finer resolution.
3. **C1 mapping:** `countDocuments` must allow `$skip`/`$limit`. `replaceOne` and `findOneAndReplace` *can* be detected and must be, or their hashes change. `find().limit(1)` is *not* labelled `findOne`, because it lacks `singleBatch`. `findById` already hashed as `findOne` in 0.2, so its hash doesn't change.
4. **C2 discriminators:** 0.2 did not drop the discriminator key from the shape. Dropping it changes the hash. Keep it.
5. **"`buildSignature`, `redact`, … stay as they are":** they do, but the driver's `Map` sort must be converted to a plain object first.
6. **Model registry:** "each connection's `models`" misses `useDb()` connections. They need the untyped `conn.otherDbs`, or the collection-only fallback.
