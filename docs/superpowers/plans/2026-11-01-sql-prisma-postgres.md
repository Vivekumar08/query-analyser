# SQL, Prisma and PostgreSQL (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SDK 0.4.0 captures every SQL statement a `pg` 8 app or a Prisma 5.22–7 app runs on PostgreSQL. It fingerprints each statement without values and counts it exactly once. The API stores it with errors, a fine histogram and sampling, and the dashboard shows it next to MongoDB without ever mixing the two counts.

**Architecture:**
- `packages/sdk` gains a SQL core that feeds the existing `Aggregator`:
  - `src/sql/lexer.ts` and `src/sql/fingerprint.ts`: a hand-written Postgres lexer and normaliser, with an LRU;
  - `src/sql/context.ts`: a process-wide `AsyncLocalStorage` and sink slot under `Symbol.for`;
  - `src/sql/core.ts`: sampling, labels, masking, and `Aggregator.addStatement`.
- Two capture layers sit on that core:
  - `src/integrations/pg.ts` wraps `Client.prototype.query` of every distinct `pg` copy (the app's and `@prisma/adapter-pg`'s);
  - `src/integrations/prisma.ts` puts the SDK's own tracing helper on Prisma 7's `V7_PRISMA_INSTRUMENTATION` key, and otherwise only wraps a helper the app installed itself.
- The SDK never changes SQL text: it never returns a sampled traceparent.
- The API gains nullable SQL columns, a drop-only-new quota with a `QuotaDrop` record, `/summary`, and source/ORM/database filters. The web gains filters, a per-source summary strip and a SQL detail view.
- `packages/sdk-compat` gains a `pg` 8 minor matrix, Prisma fixtures (5.22, 6.0, 6.19, 7.10, adapter and engine paths) and an overhead benchmark.

**Tech Stack:** TypeScript, Node ≥20, tsup, Vitest 2, `node:async_hooks`, `pg` 8 (dev and compat only), Prisma 5.22/6.0/6.19/7.10 with `@prisma/adapter-pg` and `@prisma/instrumentation` (compat fixtures only), PostgreSQL 14 on `localhost:5432`, zod, Fastify 5 + Prisma 7 (API), Next 16 / React 19 + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-30-sql-prisma-postgres-design.md` (the approved design) and `docs/superpowers/specs/2026-10-31-sql-prisma-spike.md` (the spike results). Read both. The design is the authority, the spike corrects it where they disagree, and the rulings made after the spike override both. Every resolution is listed under "Decisions" below.

## Global Constraints

- **SDK dependencies:**
  - Zero runtime dependencies (`"dependencies": {}`).
  - New optional peers: `"pg": ">=8.0 <9"` and `"@prisma/client": ">=5.22 <8"`, each `{ "optional": true }` in `peerDependenciesMeta`, next to the existing `mongoose` and `mongodb`.
  - tsup `external: ['mongoose', 'mongodb', 'pg', '@prisma/client', '@prisma/adapter-pg']`. SDK source never imports `pg` or any `@prisma/*` package statically. They are reached through `createRequire` or passed in, and typed structurally.
  - The SDK never reads `pg.native` (the getter loads `pg-native`).
  - `AsyncLocalStorage` comes from `node:async_hooks`.
- **Never throw into app code.** The `pg` wrapper's own work, the Prisma helper, the delegating proxy, engine-span parsing, `init()`, `instrument()` and `shutdown()` are each wrapped in `try`/`catch`. Failures go to `onError`, which is itself guarded.
- **Never change query behaviour or SQL text:**
  - The SDK never returns a sampled traceparent, so Prisma never adds a `traceparent` comment because of the SDK. Its own helper returns `DISABLED_TRACEPARENT = '00-10-10-00'`.
  - It never changes an app's sampler, tracer or exporter. A helper the app installed is delegated to, call for call.
  - `pg`: results, errors, callback arity, synchronous throws, the unhandled-rejection behaviour of a promise the app ignores, and the promise's constructor are the same with and without the SDK (Task 5 pins each one).
- **Privacy (the hard rule):**
  - The SDK reads only the SQL text (`text` or `config.text`), `client.database`, and an error's `code`. It never reads `values`, `connectionString`, `password`, `user`, `host`, any result field, an error's `message`/`detail`/`where`, or a span's parameter attributes.
  - Every literal, `$n` parameter, comment and dollar-quoted body becomes `?` or is dropped before anything is buffered.
  - SQL items carry `sample: null` and never an `encryptedSample`.
- **Mongo unchanged:** every 0.3 Mongo hash, wire key, key order and payload byte stays the same (`golden.test.ts` and `WIRE_ITEM_KEYS` must pass unchanged). Mongo stays slow-only.
- **Hash:** `sha256("postgresql\n" + normalizedSql)`, hex, first 16 characters. Model, operation, ORM and database are labels, not part of the hash.
- **Counting:**
  - Every captured SQL statement adds to `count`, `totalMs`, `histFine` and `errors`. Only statements with `durationMs >= thresholdMs` (default 100) add to the 8-bucket `hist`.
  - Durations are float milliseconds from `performance.now()`.
  - `sql.sampleRate` (0 < r ≤ 1, default 1) applies only to statements that are under the threshold and did not fail.
- **Supported versions:** `pg >=8.0 <9`; `@prisma/client >=5.22 <8`. Prisma 8 is out.
- **Publishing:** `@vivekumar08/query-analyser@0.4.0` is published only when the user says so. No task runs `npm publish` or `pnpm publish`.
- **Commits:** conventional (`feat(sdk): …`, `test(sdk): …`, `feat(api): …`, `feat(web): …`, `feat(contract): …`, `chore(sdk): …`), with no `Co-Authored-By` or other trailer. Never push.
- **Commands:**
  - SDK: `pnpm --filter @vivekumar08/query-analyser <test|typecheck|build>`. One file: `pnpm --filter @vivekumar08/query-analyser exec vitest run <file>`.
  - After any contract change, rebuild it with `pnpm --filter @query-analyser/contract build`; the SDK and API read its `dist`.
  - API: `pnpm --filter @query-analyser/api db:generate`, then `caffeinate -i pnpm --filter @query-analyser/api test`. The API suite keeps its existing pattern (`DATABASE_URL` from `apps/api/.env`, `resetDb`).
  - Web: `pnpm --filter @query-analyser/web <test|typecheck|build>`.
  - Compat: `pnpm --filter @query-analyser/sdk-compat <test|typecheck|bench|prisma:setup>`.
- **Postgres in SDK and compat tests:** always a throwaway database from `createThrowawayDb()` (Task 9). It is dropped in `afterAll` with `DROP DATABASE … WITH (FORCE)`, even when the test fails. The connection URL is never printed.
- **Existing tests:** every one stays green, and no assertion is weakened. The quota-429 tests and the `{ accepted }` response assertions are rewritten to the new behaviour (Task 12), never deleted.

## Review Focus

- **A `pg` query with no callback whose promise the app ignores** (`client.query('INSERT …')` fire-and-forget) and which fails. Without the SDK this raises `unhandledRejection` with pg's error. A reasonable user expects exactly that with the SDK too: one event, the same error object. The design's side branch (`p.then(ok, fail)`) would mark the promise handled and silently swallow it (checked on Node 26). Pinned in Task 5.
- **A submittable** (`pg-cursor`, `pg-query-stream`, `new pg.Query(...)`): the same object comes back from `query()`, its rows and events flow unchanged, it is not counted, and nothing is reported to `onError`. Pinned in Task 5.
- **Identifier masking on Prisma SQL** (every name quoted and schema-qualified, aliases such as `"_count$_all"`, casts such as `::text`, function calls such as `COUNT(*)`): no table, column, schema, alias, model or database name survives in `signature`, `sql`, `model`, `collection` or `database`, while keywords, known functions and cast types stay readable. Pinned in Task 2.
- **An app with 6,000 distinct shapes at the 5,000-signature quota:** a batch of known and new shapes stores every known item, drops only the new ones beyond the quota, answers `202 { accepted, droppedNew }`, records the drop per hour, and the SDK does not retry. Pinned in Task 12.
- **Two `pg` copies in one app** (the app's `pg` 8.11 and `@prisma/adapter-pg` 7's private `pg` 8.23, or a nested copy): both `Client.prototype`s are wrapped once each. A statement through either is counted exactly once, and a second SDK copy doesn't stack a wrapper. Pinned in Task 6 (fakes) and Task 19 (the real `p710-private` fixture).

## Decisions (design, spike and rulings)

1. **The SDK never changes the SQL sent to the database** (user ruling; spike contradiction 2).
   - It never returns a sampled traceparent.
   - The design's Prisma 5/6.0 setup line (`previewFeatures = ["tracing"]` driven by the SDK) is dropped as an SDK mechanism.
2. **Prisma capture paths:**
   - **Prisma 7 (adapter) and Prisma 5.22/6.x with `@prisma/adapter-pg`:** captured by the `pg` layer, with zero setup.
   - **Prisma 5/6 engine path (no adapter):** captured only when the app already enabled Prisma tracing itself, for example its own `@prisma/instrumentation`, or `previewFeatures = ["tracing"]` with its own provider. The SDK then wraps the app's helper and reads `prisma:engine:db_query` spans. Otherwise it captures nothing there, and the README points to `@prisma/adapter-pg` or Prisma 7.
   - The SDK installs its **own** helper only on `V7_PRISMA_INSTRUMENTATION`. On 6.1+ an enabled helper costs about 29 µs per operation and yields nothing without a sampled traceparent; 5.22/6.0 never read it without `tracing`. On the unversioned and `V6_` keys, it only ever wraps a helper the app wrote.
   - Spike contradiction 1 (init order on the 6.1+ engine path) therefore no longer applies: engine tracing is switched on by the app's own helper, not the SDK's.
3. **Delegation sees what the app samples** (controller, contradiction 3). On the adapter path every statement is still counted by `pg`, and only the Prisma labels can be partial. On the engine path only sampled operations are captured. The SDK never alters the sampler. This is documented as a limitation.
4. **`pg` copies** (controller, contradiction 5):
   - The SDK resolves `pg` from the app, from `@prisma/adapter-pg`'s own entry point (resolved from the app; `package.json` is not exported), and from `init({ pg })`. It wraps every distinct `Client.prototype`, deduplicated by identity.
   - `instrument(pool | client)` remains only for a bundled `pg` the SDK cannot resolve. It is never presented as the remedy for the adapter's private copy.
5. **Prisma 5/6 on the adapter path** (controller, contradictions 4, 7, 8):
   - There is no per-operation claim (context does not survive the engine→JS hop).
   - The `pg` layer labels a statement `orm: 'prisma'` only when it can infer it: the call has the adapter's shape (`rowMode: 'array'` and a `types` object with a `getTypeParser` function) **and** `@prisma/adapter-pg` was resolved at `init()`. Model and operation then come from the SQL (table and verb). Otherwise it has no ORM label.
   - With app tracing on the engine path, engine `db_query` spans that have a `js:query` child are skipped, because `pg` counted them.
   - `$transaction([...])` and same-tick batches carry the first operation's label.
   - On 5.22/6.0, the model comes from the SQL table.
   - All of these are documented limitations, with no fallback rule.
6. **Hashes** can change on Prisma 6.x minor upgrades (controller, contradiction 6). This is documented, with no cross-version normalisation in V1. Spike Q6's optional `INSERT` column sorting is not done either.
7. **`pg` promise form (correction to the design):**
   - The design's "return the original promise and observe a side branch" hides the rejection of a promise the app ignores (Review Focus 1).
   - The wrapper returns `p.then(onOk, onErr)` instead. `onOk` records and returns the value; `onErr` records and re-throws the same error.
   - Because pg's own promise never escapes to the app, the swap is unobservable except for one microtask. The constructor stays pg's (`client.Promise` when the app sets one), and an ignored rejection still surfaces as exactly one `unhandledRejection` with the same error object. This keeps both of the design's anti-goals.
   - The callback form wraps the callback with the same `length`. The `config.callback` form passes `Object.create(config, { callback: { value: wrapped } })`, so pg reads every other field through the prototype.
8. **`init({ prisma })` is not added.** Its two purposes in the design (the client version and a model-to-table map) are covered by resolving `@prisma/client`'s version from disk, and by labelling raw SQL from the table. The table map would need Prisma internals, which the design rules out.
9. **Labels:**
   - `model` is Prisma's model, else the statement's table, else `(sql)`.
   - `operation` is Prisma's method, else the lower-case verb.
   - `collection` is the table, else the model.
   - The table is the last part of a qualified name, unquoted (`"public"."User"` gives `User`).
   - In the SDK and in the API, an item that has no `orm` takes all three labels from the first later item that has one (design S7). Once set, they never change.
10. **`database`** is a label, not in the hash. The same SQL on two databases is one row, and its first database wins. The Database filter can under-report. This is documented.
11. **Masking** (`sql.maskIdentifiers`):
    - It masks quoted and unquoted identifiers, Prisma's model, the table and the `database` name, each as `t_` plus the first 8 hex characters of the sha256 of the name. An unquoted name is lower-cased first.
    - Kept: keywords, the `KNOWN_FUNCTIONS` list, and type names right after `::`.
    - **Changed during implementation (Task 2 fix, 2026-11-02):** masking is HMAC-SHA256 keyed by `sha256('qa-mask:' + apiKey)`, written as `t_` plus 16 hex characters, not a plain sha256 with 8 hex characters.
12. **Errors:**
    - A failed statement counts in `errors`, whatever its SQLSTATE. The code is recorded when it matches `/^[0-9A-Z]{5}$/`.
    - Engine spans carry no SQLSTATE, so on the delegated engine path failures are not counted as errors. This is documented.
13. **Weighted counting:** the aggregator accumulates float weights in `count`, `totalMs` and `histFine`.
    - `toWireItem` rounds `histFine` with the largest-remainder method so that its sum is `Math.round(sum of weights)`, and sets `count` to that sum.
    - `totalMs` is sent as a float rounded to 3 decimals.
    - `hist` and `errors` are always exact, because slow and failed statements have weight 1.
14. **Fine histogram:** `FINE_HIST_BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]` and `FINE_HIST_SIZE = 14`, in `@query-analyser/contract/runtime`.
15. **Quota drop record:**
    - A new `QuotaDrop` table with primary key `(appId, bucketHour)` and a `droppedNew Int` counter.
    - The response is `202 { accepted, droppedNew }`. The SDK already treats any 2xx as delivered.
16. **Re-wrapping after a late or removed app instrumentation:**
    - Configurable accessors on `globalThis` see every assignment.
    - An app that `delete`s a key also removes the accessor. `ensurePrismaHook()` runs on every flush and re-defines missing accessors, so a gap lasts at most `flushIntervalMs`.
17. **The unresolved warning** now covers SQL, verbatim: `query-analyser: none of mongoose, mongodb, pg or @prisma/client could be resolved and no client was given; pass init({ mongoose }), init({ mongoClient }) or init({ pg })`. A `pg`-only app no longer gets a Mongo warning.
18. **Engine-path warning,** verbatim, once per process at `init()`. It fires when `@prisma/client` 5.x or 6.x resolves, `@prisma/adapter-pg` does not, and no helper is present on any watched key: `query-analyser: @prisma/client ${version} without @prisma/adapter-pg runs its SQL inside the query engine, which the SDK captures only when your app already enables Prisma tracing. Use @prisma/adapter-pg, or Prisma 7, to capture these queries.`

19. **"No fine histogram" is an empty array, not NULL.** Prisma can't declare a nullable scalar list, so `histFine Int[]` uses `'{}'` for Mongo rollups, with `CHECK (cardinality("histFine") IN (0, 14))`. The read routes turn an empty sum into `null`.

---

## File Structure

**Contract:** `packages/contract/src/runtime.ts` (SQL item keys, `FINE_HIST_*`, `ErrorCodeCount`, `IngestResponse`), `src/schema.ts`, `src/wire.ts` (`RankedQueryRow`), with tests `schema.test.ts` and `sdk-types-equality.test.ts`.

**SDK (`packages/sdk`)**
- `src/sql/keywords.ts` (new): `KEYWORDS`, `KNOWN_FUNCTIONS`, `CAPTURED_VERBS`.
- `src/sql/lexer.ts` (new): `lex(text): Token[]`. Test: `src/sql/lexer.test.ts`.
- `src/sql/fingerprint.ts` (new): `fingerprintSql`, `createFingerprinter`, `maskName`. Tests: `src/sql/fingerprint.test.ts`, `src/sql/corpus.test.ts`.
- `src/sql/context.ts` (new): `sqlRuntime()` and the frame types. Test: `src/sql/context.test.ts`.
- `src/sql/core.ts` (new): `createSqlSink`, `sqlStateOf`. Test: `src/sql/core.test.ts`.
- `src/integrations/pg.ts` (new): `installPgWrap`, `undoPgWraps`, `PG_QUERY_WRAP`. Test: `src/integrations/pg.test.ts`.
- `src/integrations/prisma.ts` (new): the helper, the delegating proxy, engine-span readers. Test: `src/integrations/prisma.test.ts`.
- `src/wire-item.ts` (new, `toWireItem` moved out of `index.ts`) and `roundWeighted`. Test: `src/wire-item.test.ts`.
- `src/aggregator.ts` (`addStatement`, SQL merge), `src/types.ts`, `src/drivers.ts` (`resolvePeerPath`, `resolvePgModules`, `pgClientOf`, `prismaClientVersion`), `src/index.ts`.
- `src/__tests__/pg-db.ts` (new): `createThrowawayDb`. `src/__tests__/pg-integration.test.ts` (new).
- `package.json`, `tsup.config.ts`, `README.md`, `CHANGELOG.md`.

**API:** `apps/api/prisma/schema.prisma`, `prisma/migrations/<ts>_sql_postgres/migration.sql`, `src/ingest/writer.ts`, `src/ingest/routes.ts`, `src/plugins/prisma.ts` (`ingestStats.droppedNew`), `src/analysis/percentile.ts`, `src/analysis/compaction.ts`, `src/analysis/jobs.ts`, `src/analysis/routes.ts`, `src/analysis/summary.ts` (new), and the tests next to each.

**Web:** `apps/web/src/dashboard-types.ts`, `src/dashboard-api.ts`, `src/filters.ts`, `src/queries-view.ts`, `src/hist.ts`, `src/detail-view.ts`, `src/sources.ts` (new), `components/dashboard/QueryFilters.tsx`, `QueriesTable.tsx`, `SummaryStrip.tsx` (new), `SqlQueryDetail.tsx` (new), `TrendChart.tsx`, `app/dashboard/[org]/[app]/queries/page.tsx`, `queries/[sig]/page.tsx`, `app/page.tsx`, `components/onboarding/InstallStep.tsx`, `components/onboarding/snippet.ts`, and their tests.

**Compat (`packages/sdk-compat`):**
- `package.json`: the `pg` aliases and the `prisma:setup` script.
- `src/pg-harness.ts`, `src/pg.test.ts`, `src/prisma.test.ts`, `src/sql-overhead.test.ts`.
- `scripts/prisma-setup.mjs`.
- `prisma-fixtures/{p522,p601,p619,p710,p710-private}/` (each with `package.json` and `schema.prisma`; plus `prisma.config.ts` for the 7 fixtures), and `prisma-fixtures/.gitignore`.

---

## Step B: core

### Task 1: Contract — SQL item keys, the fine histogram, the ingest response

**Files:**
- Modify: `packages/contract/src/runtime.ts`, `packages/contract/src/schema.ts`, `packages/sdk/src/types.ts`
- Test: `packages/contract/src/schema.test.ts`, `packages/contract/src/sdk-types-equality.test.ts`

**Interfaces:**
- Produces (the contract and the SDK copy are identical; the new item keys go after `collection` and before `encryptedSample`):

```ts
export const FINE_HIST_BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
export const FINE_HIST_SIZE = 14;
export interface ErrorCodeCount { code: string; count: number }
// IngestItem gains, each with a doc comment ("SQL items only; absent on Mongo items and on SDK 0.1–0.3"):
orm?: string; database?: string; sql?: string; errors?: number;
errorCodes?: ErrorCodeCount[]; histFine?: number[]; sampleRate?: number;
export interface IngestResponse { accepted: number; droppedNew: number }   // contract only
```

- Schema:
  - `orm: z.string().min(1).max(40).optional()`
  - `database: z.string().min(1).max(255).optional()`
  - `sql: z.string().min(1).max(16_384).optional()`
  - `errors: z.number().int().nonnegative().optional()`
  - `errorCodes: z.array(z.object({ code: z.string().regex(/^[0-9A-Z]{5}$/), count: z.number().int().positive() })).max(8).optional()`
  - `histFine: z.array(z.number().int().nonnegative()).length(FINE_HIST_SIZE).optional()`
  - `sampleRate: z.number().gt(0).lte(1).optional()`

- [ ] **Step 1: Write the failing tests**

`schema.test.ts`, a new `describe('sql item keys')` that reuses `item` and `payload`:

```ts
const sqlItem = { ...item, source: 'postgresql', collection: 'User', orm: 'prisma', database: 'shop', sql: 'SELECT id FROM "User" WHERE id = ?',
  errors: 2, errorCodes: [{ code: '23505', count: 2 }], histFine: [0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0], sampleRate: 0.1 };
it('accepts a 0.4 SQL item with every key', () =>
  expect(ingestPayloadSchema.parse({ ...payload, items: [sqlItem] }).items[0]).toMatchObject(sqlItem));
it('a 0.3 Mongo item still parses with none of the new keys', () => {
  const parsed = ingestPayloadSchema.parse({ ...payload, items: [{ ...item, source: 'mongodb', collection: 'orders' }] }).items[0]!;
  for (const k of ['orm', 'database', 'sql', 'errors', 'errorCodes', 'histFine', 'sampleRate']) expect(parsed).not.toHaveProperty(k);
});
it.each([
  { histFine: [1, 2] }, { sampleRate: 0 }, { sampleRate: 1.5 }, { errors: -1 }, { errors: 1.5 },
  { errorCodes: [{ code: '2350', count: 1 }] }, { errorCodes: [{ code: '23505', count: 0 }] },
  { errorCodes: Array.from({ length: 9 }, (_, i) => ({ code: `2350${i}`, count: 1 })) },
  { sql: 'x'.repeat(16_385) }, { orm: '' }, { database: 'd'.repeat(256) },
])('rejects %o', (extra) => expect(ingestPayloadSchema.safeParse({ ...payload, items: [{ ...sqlItem, ...extra }] }).success).toBe(false));
it('FINE_HIST_SIZE is one more than the bounds', () => expect(FINE_HIST_SIZE).toBe(FINE_HIST_BOUNDS.length + 1));
```

`sdk-types-equality.test.ts`:

```ts
type _ErrorCodeCount = AssertTrue<Equal<ErrorCodeCount, SdkErrorCodeCount>>;
type _ItemCarriesSql = AssertTrue<Equal<IngestItem['histFine'], number[] | undefined>>;
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/contract test`
Expected: FAIL. The SQL item loses its keys, and `ErrorCodeCount` doesn't exist.

- [ ] **Step 3: Implement** the constants, types and schema keys above, in both `IngestItem` copies.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/contract test && pnpm --filter @query-analyser/contract typecheck && pnpm --filter @query-analyser/contract build && pnpm --filter @vivekumar08/query-analyser typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src packages/sdk/src/types.ts
git commit -m "feat(contract): optional sql item keys and the fine histogram"
```

---

### Task 2: SDK — Postgres lexer, normaliser and fingerprint

**Files:**
- Create: `packages/sdk/src/sql/keywords.ts`, `src/sql/lexer.ts`, `src/sql/fingerprint.ts`
- Test: `packages/sdk/src/sql/lexer.test.ts`, `src/sql/fingerprint.test.ts`, `src/sql/corpus.test.ts`

**Interfaces:**
- Produces:

```ts
// keywords.ts
export const KEYWORDS: ReadonlySet<string>;        // upper case
export const KNOWN_FUNCTIONS: ReadonlySet<string>; // lower case; never masked
export const CAPTURED_VERBS: ReadonlySet<string>;  // SELECT INSERT UPDATE DELETE MERGE WITH VALUES TABLE CALL
// lexer.ts
export type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'param' | 'op' | 'punct';
export interface Token { kind: TokenKind; text: string }   // comments and whitespace are not tokens
export function lex(text: string): Token[];                 // pure, never throws
// fingerprint.ts
export const MAX_SQL_CHARS = 16_384;
export const MAX_INPUT_CHARS = 262_144;
export interface SqlFingerprint { sql: string; hash: string; verb: string; table: string | null }
export function fingerprintSql(text: string, opts: { maskIdentifiers: boolean }): SqlFingerprint | null; // null = not a captured statement
export function maskName(name: string): string;             // 't_' + sha256(name).hex.slice(0, 8)
export function createFingerprinter(opts: { maskIdentifiers: boolean; maxEntries?: number }): (text: string) => SqlFingerprint | null;
```

- **`KEYWORDS`:** every word marked "reserved" in the PostgreSQL column of the PostgreSQL docs' Appendix C table, plus `BETWEEN BY CALL CONFLICT CROSS DELETE EXISTS FILTER FIRST FULL ILIKE INNER INSERT INTERVAL IS ISNULL JOIN LAST LEFT LIKE LOCKED MATCHED MERGE NATURAL NOTHING NOTNULL NOWAIT NULLS OUTER OVER PARTITION RECURSIVE RIGHT ROWS SET SHARE SIMILAR SKIP UPDATE VALUES ESCAPE`.
- **`KNOWN_FUNCTIONS`:** `count sum avg min max coalesce nullif greatest least lower upper length now array_agg json_agg jsonb_agg string_agg row_number rank dense_rank date_trunc extract unnest jsonb_build_object json_build_object to_char to_timestamp abs round floor ceil random gen_random_uuid concat substring position trim`.
- **Lexer:**
  - `'…'` with `''`;
  - `E'…'` with backslash escapes;
  - `B'…'`, `X'…'`, `U&'…'`;
  - `$tag$…$tag$` and `$$…$$`;
  - `"…"` with `""`;
  - numbers (decimals, exponents, `0x`/`0o`/`0b`, `_` separators);
  - `$n`;
  - `--` comments and nested `/* */` comments;
  - `::` as one `op`;
  - other operator runs as `op`, and `( ) [ ] , ; .` as `punct`.
  - An unterminated string, quoted identifier, dollar quote or block comment turns the rest of the text into one `string` token (a `string` becomes `?`; an unterminated comment is dropped).
- **Normalisation, in this order:**
  1. Cap the input at `MAX_INPUT_CHARS`. If it was cut, the token list ends with a `…` punct.
  2. Literals and `$n` become `?`; `NULL`, `TRUE`, `FALSE` and `DEFAULT` stay as keywords.
  3. A keyword is upper-cased. Any other unquoted word is lower-cased. A quoted identifier keeps its quotes and case.
  4. `IN (?, …)` and `ARRAY[?, …]` (only `?` and commas inside) become `IN (?)` and `ARRAY[?]`.
  5. After `VALUES`, consecutive `( … )` tuples separated by commas keep the first tuple only.
  6. Join the tokens with single spaces, except:
     - no space before `, ) ] . ::` or after `( [ . ::`;
     - no space between an unquoted non-keyword word and a following `(` (a function call);
     - no space between `ARRAY` and `[`.
  7. `sql` = the result, cut to `MAX_SQL_CHARS - 1` characters plus `…` when longer. The hash covers the full uncut result.
- **Verb and table:**
  - The verb is the first word token, skipping leading `(`, upper-cased. Return `null` unless it is in `CAPTURED_VERBS`.
  - For `WITH` (optionally `RECURSIVE`), skip the CTE list at depth 0. The verb is then the next of `SELECT INSERT UPDATE DELETE MERGE`; with none, return `null`.
  - `verb` is lower-cased in the result.
  - `table` is the first name after `FROM`, `INTO`, `UPDATE` or the verb `TABLE`, at depth 0 of the main statement. It is the last part of a dotted name, unquoted, as written (before masking it is case-preserved for quoted names and lower-cased for unquoted ones). It is `null` when there is no such name.
- **Masking:** every `word` that is not a keyword and not in `KNOWN_FUNCTIONS`, every `quoted` token, and `table` become `maskName(name)`. An unquoted name is lower-cased first; a quoted name is unquoted and kept as is. A `word` directly after `::` is a type and stays.
- **Hash:** `createHash('sha256').update('postgresql\n' + fullSql).digest('hex').slice(0, 16)`.
- **`createFingerprinter`:** an LRU `Map` of `maxEntries` (default 2,000), keyed by the raw text. Texts longer than 16,384 characters are not cached. A hit moves the entry to the end.

- [ ] **Step 1: Write the failing tests**

`lexer.test.ts`:

```ts
it.each([
  [`'it''s'`, 'string'], [`E'it\\'s'`, 'string'], [`B'101'`, 'string'], [`X'ff'`, 'string'], [`U&'d\\0061t'`, 'string'],
  ['$tag$a $$ b$tag$', 'string'], ['$$x$$', 'string'], ['"My ""T"""', 'quoted'], ['1_000.5e-3', 'number'], ['0x1F', 'number'], ['$12', 'param'],
])('lexes %s as one %s token', (text, kind) => expect(lex(text)).toEqual([{ kind, text }]));
it('drops -- and nested /* */ comments', () => expect(lex('/* a /* b */ c */ SELECT 1 -- x').map((t) => t.text)).toEqual(['SELECT', '1']));
it('an unterminated string swallows the rest as one string token', () =>
  expect(lex(`SELECT 'abc FROM t`)).toEqual([{ kind: 'word', text: 'SELECT' }, { kind: 'string', text: `'abc FROM t` }]));
it('an unterminated dollar quote and an unterminated comment do not throw', () => {
  expect(() => lex('SELECT $q$abc')).not.toThrow();
  expect(lex('SELECT 1 /* open').map((t) => t.text)).toEqual(['SELECT', '1']);
});
it('never throws on 10,000 random strings', () => { /* seeded random chars from `'"$-/*()[]:;,.` plus letters and digits */ });
```

`fingerprint.test.ts`. Golden cases, as `[input, sql, verb, table]` rows in one `it.each('normalises %s')`:

| input | `sql` | verb | table |
|---|---|---|---|
| `SELECT * FROM users WHERE email = 'a@b.c'` | `SELECT * FROM users WHERE email = ?` | `select` | `users` |
| `select id from "public"."User" where "User"."email" = $1 limit $2 offset $3` | `SELECT id FROM "public"."User" WHERE "User"."email" = ? LIMIT ? OFFSET ?` | `select` | `User` |
| `SELECT a FROM t WHERE id IN (1, 2, 3) AND b NOT IN ($1,$2)` | `SELECT a FROM t WHERE id IN (?) AND b NOT IN (?)` | `select` | `t` |
| `SELECT a FROM t WHERE id = ANY (ARRAY[$1, $2, $3])` | `SELECT a FROM t WHERE id = ANY (ARRAY[?])` | `select` | `t` |
| `INSERT INTO "public"."Product" ("sku","name") VALUES ($1,$2), ($3,$4) RETURNING "public"."Product"."id"` | `INSERT INTO "public"."Product" ("sku", "name") VALUES (?, ?) RETURNING "public"."Product"."id"` | `insert` | `Product` |
| `/* traceparent='00-ab-cd-01' */ SELECT a FROM t -- trailing` | `SELECT a FROM t` | `select` | `t` |
| `SELECT $tag$secret$tag$, E'x\'y', 1.5e3, 0x1F, NULL, TRUE` | `SELECT ?, ?, ?, ?, NULL, TRUE` | `select` | `null` |
| `SELECT $1::text, '2020-01-01'::date` | `SELECT ?::text, ?::date` | `select` | `null` |
| `select COUNT(*) AS "_count$_all" from Users` | `SELECT count(*) AS "_count$_all" FROM users` | `select` | `users` |
| `WITH x AS (SELECT a FROM t) UPDATE u SET a = 1 FROM x` | `WITH x AS (SELECT a FROM t) UPDATE u SET a = ? FROM x` | `update` | `u` |
| `(SELECT 1)` | `(SELECT ?)` | `select` | `null` |
| `TABLE users` | `TABLE users` | `table` | `users` |
| `SELECT "title"::text LIKE ($1 \|\| $2 \|\| $3) FROM "Post"` | `SELECT "title"::text LIKE (? \|\| ? \|\| ?) FROM "Post"` | `select` | `Post` |
| `SELECT 'abc` | `SELECT ?` | `select` | `null` |

Plus:

```ts
it.each(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a', 'RELEASE a', 'SET search_path TO x', 'SHOW x', 'RESET x', 'DISCARD ALL',
  'DEALLOCATE x', 'LISTEN c', 'CREATE TABLE t (a int)', 'ALTER TABLE t ADD b int', 'DROP TABLE t', 'WITH x AS (SELECT 1) ', ''])
  ('ignores %j', (s) => expect(fingerprintSql(s, { maskIdentifiers: false })).toBeNull());
it('hash is sha256 of the source prefix and the normalised SQL', () => {
  const f = fingerprintSql('SELECT 1', { maskIdentifiers: false })!;
  expect(f.hash).toBe(createHash('sha256').update('postgresql\nSELECT ?').digest('hex').slice(0, 16));
});
it('the same statement with different values, spacing, case and comments has one hash', () => { /* 4 variants → 1 hash */ });
it('caps sql at 16,384 chars with a … marker, while the hash covers the whole text', () => {
  const a = fingerprintSql(`SELECT ${'a, '.repeat(9000)}b FROM t`, { maskIdentifiers: false })!;
  const b = fingerprintSql(`SELECT ${'a, '.repeat(9000)}c FROM t`, { maskIdentifiers: false })!;
  expect(a.sql).toHaveLength(MAX_SQL_CHARS); expect(a.sql.endsWith('…')).toBe(true); expect(a.hash).not.toBe(b.hash);
});
it('an input over 256 KiB is fingerprinted deterministically', () => { /* the same 300 KiB text twice → equal hash; sql ends with '…' */ });
it('the fingerprinter caches by raw text and evicts the oldest', () => { /* maxEntries 2: a, b, a, c → b evicted (spy on lex call count) */ });
```

**Review Focus: masking** (`describe('maskIdentifiers')`):

```ts
const PRISMA = `SELECT "public"."Patient"."ssn", COUNT(*) AS "_count$_all" FROM "public"."Patient" WHERE "public"."Patient"."email" = $1 AND lower(nick) = $2 AND x::text = $3 GROUP BY 1`;
it('masks every schema, table, column and alias, keeps keywords, known functions and cast types', () => {
  const f = fingerprintSql(PRISMA, { maskIdentifiers: true })!;
  for (const secret of ['public', 'Patient', 'ssn', '_count', 'email', 'nick', '"']) expect(f.sql).not.toContain(secret);
  expect(f.sql).toBe(`SELECT ${maskName('public')}.${maskName('Patient')}.${maskName('ssn')}, count(*) AS ${maskName('_count$_all')} FROM ${maskName('public')}.${maskName('Patient')} WHERE ${maskName('public')}.${maskName('Patient')}.${maskName('email')} = ? AND lower(${maskName('nick')}) = ? AND ${maskName('x')}::text = ? GROUP BY ?`);
  expect(f.table).toBe(maskName('Patient'));
});
it('an unquoted name and the same name quoted in lower case mask alike', () =>
  expect(fingerprintSql('SELECT a FROM Users', { maskIdentifiers: true })!.sql).toBe(fingerprintSql('SELECT "a" FROM "users"', { maskIdentifiers: true })!.sql));
it('masking changes the hash', () => { /* masked hash !== unmasked hash */ });
```

`corpus.test.ts`: `'Prisma SQL of each major normalises to its golden output'`. It holds at least 4 statements per Prisma line (5.22 engine, 6.19 engine, 7.10 adapter: `findUnique`, `findMany` with `include`, `count`, `createMany`). The inputs are the raw texts recorded in Task 19, with values already parameterised. Each has its golden `sql` and `hash` inline. Write the texts from the spike's Q4 table now, and replace them with the recorded ones in Task 19 if they differ.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/sql`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement** `keywords.ts`, then `lexer.ts` (one pass with a cursor; no regex over the whole text), then `fingerprint.ts`. None of them import anything except `node:crypto`.

- [ ] **Step 4: Run to verify they pass**

Run: the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/sql
git commit -m "feat(sdk): sql-aware postgres fingerprinting with optional identifier masking"
```

---

### Task 3: SDK — per-item source, weighted SQL statements, and the wire item

**Files:**
- Modify: `packages/sdk/src/aggregator.ts`, `packages/sdk/src/index.ts` (import `toWireItem`)
- Create: `packages/sdk/src/wire-item.ts`, `packages/sdk/src/wire-item.test.ts`
- Test: `packages/sdk/src/aggregator.test.ts`, `packages/sdk/src/index.test.ts` (unchanged `WIRE_ITEM_KEYS` must still pass)

**Interfaces:**
- Consumes: `FINE_HIST_BOUNDS`, `FINE_HIST_SIZE` (Task 1).
- Produces:

```ts
// aggregator.ts
export interface SqlStatement {
  hash: string; signature: string; model: string; operation: string; table: string | null;
  orm?: string; database?: string; sql: string;
  durationMs: number; slow: boolean; weight: number; failed: boolean; errorCode: string | null; sampleRate: number;
}
export interface AggregatedItem extends IngestItem { sampleText?: string; codeCounts?: Map<string, number> }
addStatement(st: SqlStatement): boolean;   // false when a new hash is dropped at maxSignatures
export function fineBucketIndex(ms: number): number;
// wire-item.ts
export function roundWeighted(weights: readonly number[]): number[]; // largest remainder; sum === Math.round(sum(weights)); ties → lower index
export function toWireItem(item: AggregatedItem): IngestItem;
```

- **`addStatement`:**
  - A new item gets `signature`, `hash`, `model`, `operation`, `filterShape: []`, `sortKeys: []`, `stages: []`, `sample: null`, `source: 'postgresql'`, `collection: (table ?? model).slice(0, 255)`, `orm?`, `database?`, `sql`, `errors: 0`, a zero `histFine`, and a zero `hist`.
  - Every call:
    - `count += weight`, `totalMs += durationMs * weight`, `histFine[fineBucketIndex(ms)] += weight`;
    - when `slow`, `addToHist(hist, ms)`;
    - `maxMs`, `lastMs` and `lastTs` as in `add` (`maxMs` from the raw duration);
    - when `failed`, `errors += 1`, and when `errorCode` is set, `codeCounts[code] += 1`;
    - when `sampleRate < 1`, `sampleRate = min(stored ?? 1, sampleRate)`.
  - **Label fill:** when the item has no `orm` and `st.orm` is set, copy `orm`, `model` and `operation` from `st`.
- **`merge`** of SQL items: also adds `errors`, `histFine` (element-wise) and `codeCounts`, takes the lower `sampleRate`, and applies the same label fill.
- **`toWireItem`:**
  - The 0.3 keys, in the 0.3 order, with `source: item.source ?? 'mongodb'` and `collection: item.collection ?? item.model`.
  - When `item.source` is set and isn't `'mongodb'`, it then appends in this order:
    - `orm`, `database` (each only when set);
    - `sql`, `errors`, `histFine` (rounded);
    - `errorCodes` (only when `codeCounts` is non-empty: the top 8 by count descending, then code ascending);
    - `sampleRate` (only when below 1).
  - `count` is the sum of the rounded `histFine`; `totalMs` is `Math.round(totalMs * 1000) / 1000`.
  - Mongo items are exactly as in 0.3.

- [ ] **Step 1: Write the failing tests**

`wire-item.test.ts`:

```ts
it('roundWeighted keeps the total and rounds by largest remainder', () => {
  expect(roundWeighted([10, 10, 10, 0.4])).toEqual([10, 10, 10, 0]);
  expect(roundWeighted([3.4, 3.4, 3.2])).toEqual([4, 3, 3]);
  expect(roundWeighted([0, 0])).toEqual([0, 0]);
});
it('a Mongo item serialises exactly as 0.3', () => {
  const agg = new Aggregator(10); agg.add(sigA, 120, null, undefined, 'orders');
  expect(Object.keys(toWireItem(agg.swap().items[0]!))).toEqual([...MONGO_03_KEYS]);  // the 16 keys, signature … collection
});
it('a SQL item carries the SQL keys after collection, in order', () => {
  const agg = new Aggregator(10);
  agg.addStatement(stmt({ durationMs: 150, slow: true, failed: true, errorCode: '23505', orm: 'prisma', database: 'shop' }));
  const w = toWireItem(agg.swap().items[0]!);
  expect(Object.keys(w)).toEqual([...MONGO_03_KEYS, 'orm', 'database', 'sql', 'errors', 'histFine', 'errorCodes']);
  expect(w).toMatchObject({ source: 'postgresql', count: 1, errors: 1, errorCodes: [{ code: '23505', count: 1 }], hist: [0, 1, 0, 0, 0, 0, 0, 0] });
  expect(ingestPayloadSchema.safeParse({ ...basePayload, items: [w] }).success).toBe(true);
});
it('weighted fast statements round so the fine buckets sum to count; hist stays exact', () => {
  const agg = new Aggregator(10);
  for (let i = 0; i < 3; i++) agg.addStatement(stmt({ durationMs: 3, weight: 10, sampleRate: 0.1 }));
  agg.addStatement(stmt({ durationMs: 150, slow: true, weight: 1, sampleRate: 0.1 }));
  const w = toWireItem(agg.swap().items[0]!);
  expect(w.count).toBe(31); expect(w.histFine!.reduce((a, b) => a + b, 0)).toBe(31);
  expect(w.hist).toEqual([0, 1, 0, 0, 0, 0, 0, 0]); expect(w.sampleRate).toBe(0.1);
});
it('keeps only the top 8 error codes', () => { /* 10 codes with counts 10..1 → 8 entries, highest first */ });
```

`aggregator.test.ts`:

```ts
it('a later prisma-labelled statement fills the labels of a pg-first item once', () => {
  agg.addStatement(stmt({ model: 'User', operation: 'select' }));
  agg.addStatement(stmt({ orm: 'prisma', model: 'User', operation: 'findMany' }));
  agg.addStatement(stmt({ orm: 'prisma', model: 'User', operation: 'findFirst' }));
  expect(agg.swap().items[0]).toMatchObject({ orm: 'prisma', operation: 'findMany', count: 3 });
});
it('addStatement returns false for a new hash past the cap and counts it as dropped', () => { /* maxSignatures 1 */ });
it('merge folds SQL errors, histFine, codes and the lowest sample rate', () => { /* swap, add again, merge back → sums */ });
it('Mongo add() is unchanged: no source key on the buffered item', () => { /* add → item has no 'source' own property */ });
```

`stmt(over)` builds a `SqlStatement` with `hash: 'h'.repeat(16)`, `signature`/`sql` `'SELECT ?'`, `table: 'users'`, `durationMs: 5`, `slow: false`, `weight: 1`, `failed: false`, `errorCode: null`, `sampleRate: 1`, spread with `over`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/aggregator.test.ts src/wire-item.test.ts`
Expected: FAIL. `addStatement` and `wire-item.js` are missing.

- [ ] **Step 3: Implement** `addStatement`, the merge additions and `fineBucketIndex` in `aggregator.ts`. Move `toWireItem` from `index.ts` to `wire-item.ts`, adding the SQL keys and `roundWeighted`.

- [ ] **Step 4: Run the SDK suite**

Run: `pnpm --filter @vivekumar08/query-analyser test && pnpm --filter @vivekumar08/query-analyser typecheck`
Expected: all pass, including `golden.test.ts` and every `WIRE_ITEM_KEYS` assertion, unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): weighted sql statements in the aggregator, with source per item"
```

---

### Task 4: SDK — the SQL runtime (frames and sink slot) and the SQL core

**Files:**
- Create: `packages/sdk/src/sql/context.ts`, `src/sql/core.ts`
- Test: `packages/sdk/src/sql/context.test.ts`, `src/sql/core.test.ts`

**Interfaces:**
- Consumes: `createFingerprinter`, `maskName` (Task 2); `Aggregator.addStatement`, `SqlStatement` (Task 3).
- Produces:

```ts
// context.ts
export interface OperationFrame { readonly kind: 'operation'; readonly model: string | null; readonly operation: string }
export interface StatementFrame { readonly kind: 'statement'; readonly op: OperationFrame | null; claimed: boolean }
export type SqlFrame = OperationFrame | StatementFrame;
export interface Labels { orm: string; model: string | null; operation: string | null }
export interface SqlRuntime {
  readonly als: AsyncLocalStorage<SqlFrame>;
  sink: SqlSink | null;            // the active analyser's sink, whichever SDK copy installed the hooks
  prismaAdapterResolved: boolean;  // set by init(); enables the adapter-shape inference (Decision 5)
}
export const SQL_RUNTIME: unique symbol; // Symbol.for('query-analyser.sql-runtime'), on globalThis
export function sqlRuntime(): SqlRuntime; // creates the record once per process, non-enumerable
export function labelsOf(frame: SqlFrame | undefined): Labels | null; // operation → its labels; statement → its op's labels, or { orm: 'prisma', model: null, operation: null } when op is null; undefined → null
// core.ts
export interface StatementEvent { text: string; database: string | null; durationMs: number; failed: boolean; errorCode: string | null; labels: Labels | null }
export interface SqlSink { record(ev: StatementEvent): void }
export interface SqlSinkOptions {
  aggregator: Aggregator; thresholdMs: number; sampleRate: number; maskIdentifiers: boolean;
  isDisabled(): boolean; onError(e: Error): void; random?: () => number;
}
export function createSqlSink(o: SqlSinkOptions): SqlSink;
export function sqlStateOf(err: unknown): string | null; // err.code when it matches /^[0-9A-Z]{5}$/; never reads anything else
```

- **`record` (inside `try`/`catch` → `onError`; nothing when disabled):**
  1. `slow = durationMs >= thresholdMs`.
  2. When `!slow && !failed && sampleRate < 1`, skip unless `random() < sampleRate`; a kept statement has `weight = 1 / sampleRate`, every other one `1`.
  3. `fp = fingerprinter(text)`; stop on `null`.
  4. Build the statement:
     - `model = labels?.model ?? fp.table ?? '(sql)'`, `operation = labels?.operation ?? fp.verb`, `orm = labels?.orm`;
     - with masking, `model` and `database` go through `maskName` (`fp.table` is already masked);
     - `signature = fp.sql.slice(0, 400)`, `model.slice(0, 200)`, `operation.slice(0, 40)`, `database?.slice(0, 255)`.
  5. `aggregator.addStatement(...)`.

- [ ] **Step 1: Write the failing tests**

`context.test.ts`:

```ts
it('one runtime per process, shared by every module copy', () => {
  expect(sqlRuntime()).toBe(sqlRuntime());
  expect((globalThis as Record<symbol, unknown>)[Symbol.for('query-analyser.sql-runtime')]).toBe(sqlRuntime());
});
it('labelsOf reads operation and statement frames', () => {
  const op = { kind: 'operation', model: 'User', operation: 'findMany' } as const;
  expect(labelsOf(op)).toEqual({ orm: 'prisma', model: 'User', operation: 'findMany' });
  expect(labelsOf({ kind: 'statement', op, claimed: false })).toEqual({ orm: 'prisma', model: 'User', operation: 'findMany' });
  expect(labelsOf(undefined)).toBeNull();
});
```

`core.test.ts` (`ev(over)` = `{ text: 'SELECT * FROM users WHERE id = 1', database: 'shop', durationMs: 5, failed: false, errorCode: null, labels: null, ...over }`):

```ts
it('records a raw statement under its table and verb', () => {
  sink.record(ev());
  expect(toWireItem(agg.swap().items[0]!)).toMatchObject({ model: 'users', operation: 'select', collection: 'users', source: 'postgresql',
    database: 'shop', sql: 'SELECT * FROM users WHERE id = ?', count: 1, hist: [0, 0, 0, 0, 0, 0, 0, 0] });
});
it('uses Prisma labels when given', () => { /* labels { orm: 'prisma', model: 'User', operation: 'findUnique' } → orm, model, operation */ });
it('ignores control statements', () => { /* 'BEGIN' → no items */ });
it('a statement at the threshold is slow, one below is not', () => { /* 100 → hist[1] = 1; 99.9 → hist sum 0, histFine counted */ });
it('a failure counts as an error with its SQLSTATE, whatever its duration', () => { /* failed, '23505', 2 ms → errors 1, code */ });
it('samples only fast successes; slow ones and failures are always kept', () => {
  const s = createSqlSink({ ...opts, sampleRate: 0.1, random: seq([0.5, 0.05]) });
  s.record(ev()); s.record(ev());                                // first skipped, second kept with weight 10
  s.record(ev({ durationMs: 150 })); s.record(ev({ failed: true }));
  expect(toWireItem(agg.swap().items[0]!)).toMatchObject({ count: 12, errors: 1, sampleRate: 0.1 });
});
it('a skipped statement is never fingerprinted', () => { /* spy on the lexer module: zero calls */ });
it('masks the model, table and database', () => {
  // maskIdentifiers true, labels model 'Patient', database 'clinic' →
  // model maskName('Patient'), database maskName('clinic'), collection maskName('patients'); no 'Patient'/'clinic'/'patients' anywhere in JSON.stringify(item)
});
it('sqlStateOf reads only a five-character code', () => {
  expect(sqlStateOf({ code: '23505', detail: 'Key (email)=(a@b.c)' })).toBe('23505');
  expect(sqlStateOf({ code: 'ECONNRESET' })).toBeNull();
  expect(sqlStateOf(null)).toBeNull();
});
it('never throws when the aggregator does', () => { /* addStatement throws → onError called once, record returns */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/sql/context.test.ts src/sql/core.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `context.ts` and `core.ts`** as specified. `sqlRuntime()` defines the record with `Object.defineProperty(globalThis, SQL_RUNTIME, { value, enumerable: false, configurable: true })`.

- [ ] **Step 4: Run to verify they pass** (the same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/sql
git commit -m "feat(sdk): sql core with sampling, labels and a process-wide frame store"
```

---

### Task 5: SDK — the `pg` wrapper on `Client.prototype.query`

**Files:**
- Create: `packages/sdk/src/integrations/pg.ts`, `packages/sdk/src/integrations/pg.test.ts`

**Interfaces:**
- Consumes: `sqlRuntime`, `labelsOf`, `StatementFrame` (Task 4); `sqlStateOf` (Task 4).
- Produces:

```ts
export const PG_QUERY_WRAP: unique symbol; // Symbol.for('query-analyser.pg-query-wrap'), own and non-enumerable on the prototype: { original, wrapper, hadOwn }
/** Wraps Client.prototype.query once (across SDK copies). True when newly wrapped now. Never throws. */
export function installPgWrap(Client: unknown): boolean;
/** For each prototype this copy wrapped: restore the original if the wrapper is still on top, else leave it as a pass-through. */
export function undoPgWraps(): void;
export function isAdapterShape(config: unknown): boolean; // rowMode === 'array' && types is an object with a getTypeParser function
```

- **The wrapper** `function query(this: unknown, config?: unknown, values?: unknown, callback?: unknown)`:
  - It mirrors `installConnectWrap` (`drivers.ts:113-172`): it keeps the descriptor's flags and records `hadOwn`. A prototype that already has the record, or that inherits an SDK wrapper, isn't wrapped again.
  - `rt = sqlRuntime()`. When `rt.sink` is null, the prototype isn't in this copy's `wrapped` set, `config` is null/undefined, or `typeof config.submit === 'function'` (a submittable), it returns `original.apply(this, arguments)` untouched.
  - `text = typeof config === 'string' ? config : config.text`. When `text` isn't a string, it passes through untouched.
  - In a guarded block it reads `database = this.database` (a string or null), `frame = rt.als.getStore()` and `start = performance.now()`, and defines `done(err)`:
    - it computes the duration;
    - labels: `labelsOf(frame)`. When the frame is an unclaimed `StatementFrame`, it sets `frame.claimed = true` first. With no frame, labels are `{ orm: 'prisma', model: null, operation: null }` when `rt.prismaAdapterResolved && isAdapterShape(config)`, else `null`;
    - then `rt.sink?.record({ text, database, durationMs, failed: err != null, errorCode: sqlStateOf(err), labels })`.
  - **The three forms:**
    - **Callback in `values` or `callback`:** replace that argument with `wrapped = function (this: unknown, err, res) { done(err); return cb.apply(this, arguments); }`, with `Object.defineProperty(wrapped, 'length', { value: cb.length })`. Call the original and return its result.
    - **`config.callback` is a function** (and no callback argument): pass `Object.create(config, { callback: { value: wrapped, writable: true, configurable: true, enumerable: true } })` in place of `config`.
    - **Otherwise (the promise form):** `const p = original.apply(this, arguments)`. If `p` is thenable, return `p.then((v) => { done(null); return v; }, (e) => { done(e); throw e; })`; otherwise return `p`.
  - A synchronous throw from the original propagates unchanged; `done` is not called.
  - Every SDK step (`done` included) runs in `try`/`catch` and swallows its own failure (the sink reports its own errors, Task 4), so the app's callback and value always reach the app.

- [ ] **Step 1: Write the failing tests**

They use a fake `pg`, so they need no server. `class FakeClient { database = 'shop'; constructor(private behave: Behaviour) {} query(config, values, cb) { … } }` behaves like pg 8's `query()`:
- it throws `TypeError('Client was passed a null or undefined query')` on null;
- it returns the submittable itself;
- it calls a callback (from `values`, `callback` or `config.callback`) on the next tick with `(err, res)`;
- otherwise it returns `new this.Promise(...)`.

Tests install the wrap on `FakeClient` and set `sqlRuntime().sink` to a recording sink, or to `null`.

```ts
it('promise form: resolves with the same value and records once', async () => {
  const res = { rows: [{ a: 1 }] }; const c = new FakeClient({ ok: res });
  await expect(c.query('SELECT 1')).resolves.toBe(res);
  expect(recorded).toEqual([expect.objectContaining({ text: 'SELECT 1', database: 'shop', failed: false, labels: null })]);
});
it('promise form: rejects with the same error object and records its SQLSTATE only', async () => {
  const err = Object.assign(new Error('dup'), { code: '23505', detail: 'Key (email)=(a@b.c)' });
  await expect(new FakeClient({ fail: err }).query('INSERT …')).rejects.toBe(err);
  expect(recorded[0]).toMatchObject({ failed: true, errorCode: '23505' });
  expect(JSON.stringify(recorded)).not.toContain('a@b.c');
});
it('Review Focus: an ignored failing promise still raises exactly one unhandledRejection with the same error', async () => {
  const seen: unknown[] = []; const on = (e: unknown) => seen.push(e); process.on('unhandledRejection', on);
  const err = new Error('boom'); new FakeClient({ fail: err }).query('SELECT 1');   // never awaited
  await new Promise((r) => setTimeout(r, 20)); process.off('unhandledRejection', on);
  expect(seen).toEqual([err]);
});
it('keeps the client\'s Promise constructor', async () => {
  class MyPromise<T> extends Promise<T> {}
  const c = new FakeClient({ ok: {} }); c.Promise = MyPromise;
  expect(c.query('SELECT 1')).toBeInstanceOf(MyPromise);
});
it('callback in values or callback position: same (err, res), same arity, called once', async () => { /* cb with length 2 → wrapped length 2; cb args identical; one record each */ });
it('config.callback form is captured and still receives (err, res)', async () => { /* { text, callback } → callback called with res; one record */ });
it('Review Focus: a submittable passes through untouched and uncounted', () => {
  const sub = { text: 'SELECT 1', submit: vi.fn(), on: vi.fn() };
  expect(new FakeClient({ ok: {} }).query(sub)).toBe(sub);
  expect(recorded).toHaveLength(0); expect(onError).not.toHaveBeenCalled();
});
it('a synchronous throw is re-thrown unchanged and records nothing', () => {
  expect(() => new FakeClient({ ok: {} }).query(null)).toThrow('Client was passed a null or undefined query'); expect(recorded).toHaveLength(0);
});
it('never reads values, the result or connection fields', async () => {
  // the values array, the result and the client's password/user/host are Proxies whose get traps throw → query resolves; no onError
});
it('inside an unclaimed statement frame: claims it and takes the Prisma labels', async () => {
  const frame: StatementFrame = { kind: 'statement', op: { kind: 'operation', model: 'User', operation: 'findMany' }, claimed: false };
  await sqlRuntime().als.run(frame, () => c.query('SELECT 1'));
  expect(frame.claimed).toBe(true); expect(recorded[0]!.labels).toEqual({ orm: 'prisma', model: 'User', operation: 'findMany' });
});
it('infers the prisma ORM label from the adapter call shape only when the adapter was resolved', async () => {
  const cfg = { text: 'SELECT 1', values: [], rowMode: 'array', types: { getTypeParser: () => String } };
  sqlRuntime().prismaAdapterResolved = false; await c.query(cfg); expect(recorded[0]!.labels).toBeNull();
  sqlRuntime().prismaAdapterResolved = true; await c.query(cfg); expect(recorded[1]!.labels).toEqual({ orm: 'prisma', model: null, operation: null });
});
it('is a pure pass-through with no sink: same promise object, no timing', () => { /* sink null → returned value === original's */ });
it('wraps once across SDK copies and undo restores only when on top', () => {
  // installPgWrap twice → second false; a foreign wrapper put on top → undo leaves it and ours becomes a pass-through; the inherited case deletes the own property
});
it('never throws when recording fails', async () => { /* sink.record throws → query resolves normally */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/integrations/pg.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `pg.ts`** as specified. Track wrapped prototypes in a module `Set`, and this copy's wrappers in a `WeakSet`, as `drivers.ts` does.

- [ ] **Step 4: Run to verify they pass** (the same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/integrations
git commit -m "feat(sdk): time every pg statement at Client.prototype.query"
```

---

### Task 6: SDK — find every `pg` copy: the app's, the adapter's, a given one

**Files:**
- Modify: `packages/sdk/src/drivers.ts`
- Test: `packages/sdk/src/drivers.test.ts` (it builds its fixture tree in `os.tmpdir()`)

**Interfaces:**
- Produces:

```ts
/** require.resolve with the same three strategies as resolvePeer; null when not installed. */
export function resolvePeerPath(name: string): string | null;
/** createRequire(fromFile)(name); null on any failure. */
export function requireFrom(fromFile: string, name: string): unknown | null;
/** The Client class of a pg module (CJS, or ESM with `default`); never reads `.native`. */
export function pgClientClass(mod: unknown): Function | null;
/** A pg Pool → pool.Client; a pg Client (has connectionParameters and a query function) → its constructor; else null. */
export function pgClientOf(x: unknown): Function | null;
/** Distinct Client classes, deduplicated by Client.prototype identity, from: options.pg, the app's pg,
 *  and pg required from @prisma/adapter-pg's resolved entry file. `adapterResolved` says whether that entry resolved. */
export function resolvePgClients(given?: unknown, from?: { appEntry?: (name: string) => string | null }): { clients: Function[]; adapterResolved: boolean };
/** The installed @prisma/client version (package.json found by walking up from its resolved entry), or null. */
export function prismaClientVersion(): string | null;
```

- `pgClientClass` reads only `mod.Client` and `mod.default?.Client` (as own data properties, or through ordinary getters, but never `native`).
- `resolvePgClients` uses `from.appEntry ?? resolvePeerPath` for `pg` and `@prisma/adapter-pg`, and `requireFrom(adapterEntry, 'pg')` for the adapter's copy.

- [ ] **Step 1: Write the failing tests**

`beforeAll` writes the fixture tree under `mkdtempSync(join(tmpdir(), 'qa-pg-copies-'))` as `FIX`, with `index.js` files only (`afterAll` removes it with `rmSync(FIX, { recursive: true, force: true })`):
- `app/node_modules/pg` (`exports.Client = class Client { query() {} }`);
- `app/node_modules/@prisma/adapter-pg/node_modules/pg` (a second, distinct `Client`);
- `app/node_modules/@prisma/adapter-pg/index.js`;
- `shared/node_modules/@prisma/adapter-pg` with no nested `pg`, so it shares the app's copy.

```ts
const at = (root: string) => (name: string) => { try { return createRequire(join(root, 'x.js')).resolve(name); } catch { return null; } };
it('Review Focus: an app with two pg copies yields both Client classes', () => {
  const r = resolvePgClients(undefined, { appEntry: at(FIX + '/app') });
  expect(r.clients).toHaveLength(2); expect(r.adapterResolved).toBe(true);
  expect(new Set(r.clients.map((c) => c.prototype)).size).toBe(2);
});
it('an adapter sharing the app\'s pg yields one class', () => { /* shared → 1 */ });
it('a given pg module is added and deduplicated by prototype', () => { /* given = app pg → still 2; a third module → 3 */ });
it('no pg anywhere yields none, and adapterResolved false', () => { /* appEntry () => null */ });
it('never touches pg.native', () => {
  const mod = { Client: class {}, get native(): never { throw new Error('native loaded'); } };
  expect(() => pgClientClass(mod)).not.toThrow(); expect(pgClientClass({ default: mod })).toBe(mod.Client);
});
it('pgClientOf takes a Pool or a Client and refuses anything else', () => {
  class Client { connectionParameters = {}; query() {} }
  expect(pgClientOf({ Client, totalCount: 0, query() {} })).toBe(Client);
  expect(pgClientOf(new Client())).toBe(Client);
  expect(pgClientOf(new EventEmitter())).toBeNull(); expect(pgClientOf(null)).toBeNull();
});
it('prismaClientVersion returns null when @prisma/client is not installed in the SDK', () => expect(prismaClientVersion()).toBeNull());
```

Then, in the same file, two wrapped copies counted once each (it uses Task 5):

```ts
it('Review Focus: a statement through either copy is recorded exactly once', async () => {
  // installPgWrap on both fixture Clients (with a fake promise query) → one query each → 2 records; installPgWrap again → false, still 2 after two more queries → 4
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/drivers.test.ts`
Expected: FAIL. The new exports are missing.

- [ ] **Step 3: Implement** the functions above in `drivers.ts`. `resolvePeerPath` shares `resolvePeer`'s three strategies through one private helper that returns `require.resolve(name)`.

- [ ] **Step 4: Run to verify they pass** (the same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/drivers.ts packages/sdk/src/drivers.test.ts
git commit -m "feat(sdk): resolve pg from the app and from @prisma/adapter-pg"
```

---

### Task 7: SDK — the Prisma tracing hook: own helper on 7, delegation everywhere else

**Files:**
- Create: `packages/sdk/src/integrations/prisma.ts`, `packages/sdk/src/integrations/prisma.test.ts`

**Interfaces:**
- Consumes: `sqlRuntime`, `labelsOf`, `sqlStateOf`, `OperationFrame`, `StatementFrame` (Task 4).
- Produces:

```ts
export const PRISMA_HOOK: unique symbol;  // Symbol.for('query-analyser.prisma-hook'), on globalThis: { owner: object }
export const OWN_HELPER_KEY = 'V7_PRISMA_INSTRUMENTATION';
export const WATCHED_KEYS = ['V7_PRISMA_INSTRUMENTATION', 'V6_PRISMA_INSTRUMENTATION', 'PRISMA_INSTRUMENTATION'] as const;
export const DISABLED_TRACEPARENT = '00-10-10-00';
export interface EngineStatement { text: string; durationMs: number }
/** Defines a configurable accessor on each watched key (once per process). True when installed now. */
export function installPrismaHook(): boolean;
/** Re-defines any watched accessor an app deleted. Called on every flush. */
export function ensurePrismaHook(): void;
/** Each watched key becomes a plain data property again, holding the app's own stored { helper } object, or is deleted when there is none. */
export function undoPrismaHook(): void;
/** True when an app helper is present on any watched key. */
export function appHelperPresent(): boolean;
export function createOwnHelper(): object;
export function wrapAppHelper(app: object): object; // wraps the helper object itself (stored.helper), not the { helper } holder
/** 6.1+: one dispatchEngineSpans batch → statements; skips db_query spans that have a js:query child in the batch. */
export function statementsFromBatch(spans: unknown): EngineStatement[];
/** 5.22/6.0: createEngineSpan events, children before parents; FIFO of at most `maxIds` (default 2,000) parent ids. */
export function createLegacySpanTracker(maxIds?: number): { observe(event: unknown): EngineStatement[] };
```

- **Accessors.** Prisma reads `globalThis[KEY].helper`, so every value on a key is a `{ helper }` object, the shape `@prisma/instrumentation` writes:
  - When the app stored a value, the getter returns `{ ...stored, helper: wrapAppHelper(stored.helper) }` (cached per stored object in a `WeakMap`).
  - Otherwise it returns `{ helper: ownHelper }` for `OWN_HELPER_KEY`, and `undefined` for the other keys.
  - The setter stores the assigned `{ helper }` object as the app's value.
  - A value that was already on a key at install time counts as the app's.
  - A second SDK copy finds `PRISMA_HOOK` and installs nothing.
  - Nothing is done while `sqlRuntime().sink` is null: the getter returns the app's stored object unchanged, or `undefined`.
- **Own helper:**
  - `isEnabled() → true`, `getTraceParent() → DISABLED_TRACEPARENT`, `dispatchEngineSpans() → undefined`, `getActiveContext() → undefined`.
    - *Changed during implementation (Task 19, 2026-11-03, commit 48b577e):* `isEnabled()` is always false, so Accelerate requests get no SDK headers (no `traceparent`, no `X-Capture-Telemetry`). `operation` spans still run through the helper.
  - `runInChildSpan(nameOrOptions, cb)` dispatches on the span name (a string, or `options.name`):
    - **`operation`:** `attributes.model` (a string, or null) and `attributes.method`. Run `cb` in `als.run({ kind: 'operation', model, operation: method })`.
    - **`db_query`:** `frame = { kind: 'statement', op: <the current operation frame or null>, claimed: false }`, `start = performance.now()`, and run `cb` in `als.run(frame)`. When the result is thenable, return `r.then(v => { settle(null); return v }, e => { settle(e); throw e })`, otherwise settle at once. `settle(err)`: if `!frame.claimed`, record `{ text: attributes['db.query.text'], database: null, durationMs, failed: err != null, errorCode: sqlStateOf(err), labels: labelsOf(frame) }`.
    - **Any other name:** `return cb()`.
- **`wrapAppHelper(app)`:**
  - It is a `Proxy` whose `get` passes everything through, bound to `app`, except these three:
    - `runInChildSpan`: frames as above, then `app.runInChildSpan(opts, wrappedCb)`;
    - `dispatchEngineSpans(spans, ...rest)`: record `statementsFromBatch(spans)` with `labelsOf(als.getStore())`, then `app.dispatchEngineSpans(spans, ...rest)`;
    - `createEngineSpan(ev)`: record `tracker.observe(ev)` with labels `{ orm: 'prisma', model: null, operation: null }`, then `app.createEngineSpan(ev)`.
  - Engine statements record `database: null`, `failed: false` and `errorCode: null` (Decision 12).
  - `isEnabled` and `getTraceParent` are the app's own.
- **Span formats:**
  - 6.1+: `{ id, parentId, name, startTime: [s, ns], endTime: [s, ns], attributes: { 'db.query.text' } }`;
  - 5.22/6.0: `{ span: true, spans: [{ span_id, parent_span_id, name, start_time, end_time, attributes: { 'db.statement' } }] }`.
  - A statement span's name ends with `db_query`. A child is a `js:query` span when its name contains `js:query`.
  - `durationMs = (end[0] - start[0]) * 1e3 + (end[1] - start[1]) / 1e6`.
  - Malformed spans are skipped. These functions never read any other attribute.

- [ ] **Step 1: Write the failing tests**

```ts
afterEach(() => { undoPrismaHook(); for (const k of WATCHED_KEYS) delete (globalThis as never)[k]; sqlRuntime().sink = null; });
it('installs its own helper on the V7 key only', () => {
  installPrismaHook(); sqlRuntime().sink = rec;
  const g = globalThis as Record<string, any>;
  expect(g.V7_PRISMA_INSTRUMENTATION.helper.isEnabled()).toBe(true); // changed in Task 19 (2026-11-03): always false, so Accelerate requests get no SDK headers
  expect(g.V6_PRISMA_INSTRUMENTATION).toBeUndefined(); expect(g.PRISMA_INSTRUMENTATION).toBeUndefined();
});
it('the own helper never hands out a sampled traceparent', () => expect(createOwnHelper().getTraceParent()).toBe('00-10-10-00'));
it('operation then db_query: an unclaimed statement is recorded with the operation labels and its own timing', async () => {
  const h = createOwnHelper();
  await h.runInChildSpan({ name: 'operation', attributes: { method: 'findMany', model: 'User', name: 'User.findMany' } }, () =>
    h.runInChildSpan({ name: 'db_query', attributes: { 'db.query.text': 'SELECT 1' } }, async () => 'rows'));
  expect(rec.events).toEqual([expect.objectContaining({ text: 'SELECT 1', labels: { orm: 'prisma', model: 'User', operation: 'findMany' } })]);
});
it('a db_query claimed by pg underneath is not recorded twice', async () => { /* cb sets als.getStore().claimed = true → 0 records from the helper */ });
it('returns exactly what the callback returns or throws', async () => { /* value, rejection with the same error, sync throw */ });
it('wraps an app helper assigned after install, delegates every call and keeps its traceparent', () => {
  installPrismaHook(); sqlRuntime().sink = rec;
  const app = { isEnabled: () => true, getTraceParent: () => '00-aa-bb-01', runInChildSpan: vi.fn((o, cb) => cb()), dispatchEngineSpans: vi.fn(), extra: 42 };
  (globalThis as any).V6_PRISMA_INSTRUMENTATION = { helper: app };
  const seen = (globalThis as any).V6_PRISMA_INSTRUMENTATION.helper;
  expect(seen.getTraceParent()).toBe('00-aa-bb-01'); expect(seen.extra).toBe(42);
  seen.runInChildSpan({ name: 'operation', attributes: { method: 'm' } }, () => 1); expect(app.runInChildSpan).toHaveBeenCalledOnce();
});
it('a helper already present at install time is treated as the app\'s', () => { /* set PRISMA_INSTRUMENTATION = { helper } first → appHelperPresent() true; .helper is wrapped */ });
it('statementsFromBatch skips db_query spans with a js:query child and times the rest', () => {
  const spans = [
    { id: 'a', parentId: 'op', name: 'prisma:engine:db_query', startTime: [1, 0], endTime: [1, 2_500_000], attributes: { 'db.query.text': 'SELECT 1' } },
    { id: 'b', parentId: 'op', name: 'prisma:engine:db_query', startTime: [1, 0], endTime: [1, 1_000_000], attributes: { 'db.query.text': 'SELECT 2' } },
    { id: 'c', parentId: 'b', name: 'prisma:engine:js:query:sql', startTime: [1, 0], endTime: [1, 1] },
  ];
  expect(statementsFromBatch(spans)).toEqual([{ text: 'SELECT 1', durationMs: 2.5 }]);
});
it('the legacy tracker skips a db_query whose js:query child arrived first, and bounds its id set', () => { /* child then parent → []; 2,001 children → size 2,000 */ });
it('ensurePrismaHook re-defines an accessor the app deleted', () => { /* delete V7 key → ensure → V7_PRISMA_INSTRUMENTATION.helper is the own helper again */ });
it('undo restores the app helper as a plain data property', () => { /* the descriptor's value is the app's { helper } object itself, and there is no get */ });
it('a second copy does not stack', () => { /* installPrismaHook() twice → second false */ });
it('never throws from a malformed span or a throwing app helper method', () => { /* dispatchEngineSpans(null); app.dispatchEngineSpans throws → the throw is the app's own, unchanged */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/integrations/prisma.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `prisma.ts`** as specified. Only the SDK's own steps are guarded; a throw from the app's helper method propagates exactly as it would without the SDK.

- [ ] **Step 4: Run to verify they pass** (the same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/integrations
git commit -m "feat(sdk): prisma tracing hook that never samples and delegates to the app's"
```

---

### Task 8: SDK — `init()`, `instrument()` and `shutdown()` on the SQL layers; peers and build

**Files:**
- Modify: `packages/sdk/src/index.ts`, `packages/sdk/package.json`, `packages/sdk/tsup.config.ts`
- Test: `packages/sdk/src/index.test.ts`, `packages/sdk/src/init-unresolved.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces:
  - `InitOptions.pg?: object` (the app's `pg` module) and `InitOptions.sql?: { maskIdentifiers?: boolean; sampleRate?: number }`;
  - `instrument(x)` also accepts a `pg` Pool or Client (via `pgClientOf`). Otherwise it behaves as in 0.3.
- **`init()`**, after the Mongo layer and inside the same `try`:
  1. Validate `sql.sampleRate`. A value that isn't a finite number with 0 < r ≤ 1 reports `query-analyser: sql.sampleRate must be a number greater than 0 and at most 1; using 1` and uses 1.
  2. `sqlRuntime().sink = createSqlSink({ aggregator, thresholdMs, sampleRate, maskIdentifiers: sql?.maskIdentifiers === true, isDisabled: () => disabled, onError: reportSafely })`.
  3. `const { clients, adapterResolved } = resolvePgClients(options.pg)`, then `installPgWrap` for each, and set `sqlRuntime().prismaAdapterResolved = adapterResolved`.
  4. `installPrismaHook()`.
  5. **Engine warning:** when `prismaClientVersion()` has major 5 or 6, `!adapterResolved` and `!appHelperPresent()`, report Decision 18's text once per process (module flag).
  6. **Unresolved warning:** report Decision 17's text when none of mongoose, mongodb, `pg` (no clients) or `@prisma/client` resolved, and no `mongoClient` or `pg` was given.
- **Flush:** `doFlush` calls `ensurePrismaHook()` first, guarded.
- **`shutdown()`:** where it now clears the Mongo sink, also clear `sqlRuntime().sink` if it is this analyser's sink, then call `undoPgWraps()` and `undoPrismaHook()`.
- **Repeated `init()`:** an `options.pg` given to a repeated `init()` is wrapped too, like `mongoClient`.
- **`package.json`:**
  - `peerDependencies` gains `"pg": ">=8.0 <9", "@prisma/client": ">=5.22 <8"`, and `peerDependenciesMeta` marks both `optional: true`;
  - devDependencies gain `"pg": "^8.23.0"` and `"@types/pg": "^8.11.10"`.
- **`tsup.config.ts`:** `external` per Global Constraints.

- [ ] **Step 1: Write the failing tests**

`index.test.ts`, a new `describe('sql layers')`:

```ts
it('init() wraps the resolved pg Client.prototype.query, and shutdown() restores it', async () => {
  const pg = createRequire(import.meta.url)('pg');
  init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
  expect(PG_QUERY_WRAP in pg.Client.prototype).toBe(true);
  await shutdown();
  expect(PG_QUERY_WRAP in pg.Client.prototype).toBe(false);
});
it('installs the own Prisma helper on V7 only, and shutdown() removes it', async () => { /* globalThis.V7_PRISMA_INSTRUMENTATION.helper.isEnabled() === true (changed in Task 19, 2026-11-03: always false, so Accelerate requests get no SDK headers); after shutdown, the key is absent */ });
it('a bad sql.sampleRate is reported once and treated as 1', () => {
  for (const sampleRate of [0, -1, 2, Number.NaN]) { /* onError message as specified, once per init; shutdown between */ }
});
it('a SQL statement recorded through the runtime sink is flushed as a postgresql item', async () => {
  const fetchImpl = vi.fn(okFetch); const a = init({ apiKey: 'k', app: 'x', fetchImpl });
  sqlRuntime().sink!.record({ text: 'SELECT 1 FROM t', database: 'd', durationMs: 3, failed: false, errorCode: null, labels: null });
  await a.flush();
  expect(sentItems(fetchImpl)[0]).toMatchObject({ source: 'postgresql', model: 't', operation: 'select', count: 1 });
});
it('Mongo payloads are unchanged with the SQL layers active', async () => { /* seed() → keys toEqual WIRE_ITEM_KEYS */ });
it('instrument(pool) wraps a bundled pg the SDK cannot resolve', () => {
  class Client { connectionParameters = {}; query() { return Promise.resolve({}); } }
  instrument({ Client, totalCount: 0, query() {} });
  expect(PG_QUERY_WRAP in Client.prototype).toBe(true);
});
it('maskIdentifiers reaches the sink', async () => { /* sql: { maskIdentifiers: true } → flushed model starts with 't_' */ });
it('the engine-path warning fires once for Prisma 6 without the adapter or app tracing', () => {
  // vi.spyOn(drivers, 'prismaClientVersion').mockReturnValue('6.19.3') and resolvePgClients → adapterResolved false
  // → onError called with the Decision 18 text containing '6.19.3', once across two init/shutdown cycles
});
```

`init-unresolved.test.ts`: the expected message becomes Decision 17's text. Add `'does not warn when pg resolves'` (mock `resolvePgClients` to return one class → no warning).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @vivekumar08/query-analyser install && pnpm --filter @vivekumar08/query-analyser exec vitest run src/index.test.ts src/init-unresolved.test.ts`
Expected: FAIL. Nothing is wrapped yet, and the warning text differs.

- [ ] **Step 3: Implement** the `init`, flush, `shutdown` and `instrument` changes, then `package.json` and `tsup.config.ts`.

- [ ] **Step 4: Run the SDK suite and the build**

Run: `pnpm --filter @vivekumar08/query-analyser test && pnpm --filter @vivekumar08/query-analyser typecheck && pnpm --filter @vivekumar08/query-analyser build && grep -cE "require\(\"(pg|@prisma/[a-z-]+)\"\)|from \"(pg|@prisma/[a-z-]+)\"" packages/sdk/dist/index.cjs packages/sdk/dist/index.js`
Expected: all pass. `grep` prints `0` for both files.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk pnpm-lock.yaml
git commit -m "feat(sdk): capture postgres statements from pg and prisma in init()"
```

---

### Task 9: SDK — `pg` against a real Postgres, in a throwaway database

**Files:**
- Create: `packages/sdk/src/__tests__/pg-db.ts`, `packages/sdk/src/__tests__/pg-integration.test.ts`

**Interfaces:**
- Produces (also used by Tasks 18–20 through a relative import):

```ts
/** The base URL: QA_PG_URL, else DATABASE_URL read from apps/api/.env (a regex over the file; quotes stripped). Throws a clear error when neither exists. Never logged. */
export function basePgUrl(): string;
/** CREATE DATABASE "qa_sdk_<prefix>_<pid>_<6 random hex>" over the base URL; drop() runs DROP DATABASE IF EXISTS … WITH (FORCE). */
export function createThrowawayDb(prefix: string): Promise<{ url: string; name: string; drop(): Promise<void> }>;
```

- [ ] **Step 1: Write the tests**

Each `describe` uses `beforeAll(createThrowawayDb('it'))` and `afterAll(db.drop)`, then `init({ apiKey: 'k', app: 'it', thresholdMs: 0, fetchImpl })` **after** `new pg.Pool(...)` exists, which proves that clients created before `init()` are covered.

```ts
it('counts each form exactly once: Pool.query, PoolClient.query, Client.query, callback, promise, config, named twice', async () => {
  // 7 forms over table t (8 statements: the named one twice) → sum of counts over items === 8
});
it('results, errors and callback arity are identical with and without the SDK', async () => {
  // run the same 5 calls with shutdown() and with init(): equal rows; the duplicate-key error has equal code, message and constraint
});
it('a failed statement is counted with its SQLSTATE and never its detail', async () => {
  // unique violation inserting 'canary-dup@x.test' → item errors 1, errorCodes [{ code: '23505', count: 1 }]; the body has no 'canary-dup'
});
it('never sends a value: literals, $n params, comments, dollar quotes, E strings', async () => {
  // canaries in each position → JSON bodies contain none of them; ingestPayloadSchema.parse(body) succeeds
});
it('two pools to two databases are both captured, each statement once', async () => {
  // a second throwaway db; the same SELECT on each → one item (one hash), count 2, database = the first one used (Decision 10)
});
it('a pg-cursor-like submittable is untouched and uncounted', async () => {
  // new pg.Query('SELECT 1') passed to client.query → it emits 'end'; no item
});
it('sampling at 0.1: scaled counts within 20% of the truth, slow statements and errors exact', async () => {
  // sql: { sampleRate: 0.1 }; 2,000 fast SELECTs, 5 SELECT pg_sleep(0.15), 3 failing statements → fast item count within [1,600, 2,400];
  // sleep item count 5 and hist sum 5; errors 3; every SQL item carries sampleRate 0.1
});
it('statements under the threshold are counted when thresholdMs is the default 100', async () => {
  // init without thresholdMs → SELECT 1 → item count 1, hist all zero, histFine sum 1
});
```

- [ ] **Step 2: Run**

Run: `pnpm --filter @vivekumar08/query-analyser exec vitest run src/__tests__/pg-integration.test.ts`
Expected: PASS.

Run: `psql -d postgres -Atc "select count(*) from pg_database where datname like 'qa_sdk_%'"`
Expected: `0` (no throwaway database left).

- [ ] **Step 3: Run the SDK suite**

Run: `pnpm --filter @vivekumar08/query-analyser test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/__tests__
git commit -m "test(sdk): pg capture against a real postgres in a throwaway database"
```

---

## Step B: API

### Task 10: API — migration for SQL columns, the drop record and the threshold

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_sql_postgres/migration.sql`
- Test: `apps/api/src/db.test.ts`

**Interfaces:**
- Produces:
  - `QuerySignature`: `orm String?`, `database String?`, `sqlText String?`, `lastErrorCode String?`.
  - `QueryRollup` and `QueryDailyRollup`: `errors Int @default(0)`, `histFine Int[]`, `minSampleRate Float?`.
  - `App`: `thresholdMs Int?` and a `quotaDrops QuotaDrop[]` relation.
  - `model QuotaDrop { appId String; bucketHour DateTime @db.Timestamptz(3); droppedNew Int; app App @relation(fields: [appId], references: [id], onDelete: Cascade); @@id([appId, bucketHour]) }`.
  - Each field has a `///` doc comment, e.g. `histFine`: "all-statement histogram (FINE_HIST_BOUNDS); empty for Mongo".
- **`histFine`:** Prisma has no nullable scalar list, so it is `Int[]` whose empty array means "none". The hand-added check is `CHECK (cardinality("histFine") IN (0, 14))` on both rollup tables. Everywhere below, "absent" means `cardinality = 0`.

- [ ] **Step 1: Write the failing test** in `db.test.ts`:

```ts
it('rollup histFine must be empty or 14 buckets', async () => {
  // insert a rollup with histFine of length 3 via $executeRaw → rejects with a check violation; length 0 and 14 succeed
});
it('a QuotaDrop row cascades with its app', async () => { /* delete the app → QuotaDrop count 0 */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @query-analyser/api exec vitest run src/db.test.ts`
Expected: FAIL, unknown column or model.

- [ ] **Step 3: Schema and migration**

Run: `pnpm --filter @query-analyser/api exec prisma migrate dev --create-only --name sql_postgres`
Then append to the generated `migration.sql`:

```sql
ALTER TABLE "QueryRollup" ADD CONSTRAINT "QueryRollup_histFine_length_check" CHECK (cardinality("histFine") IN (0, 14));
ALTER TABLE "QueryDailyRollup" ADD CONSTRAINT "QueryDailyRollup_histFine_length_check" CHECK (cardinality("histFine") IN (0, 14));
```

Check that the generated part is additive only: `ADD COLUMN` and `CREATE TABLE "QuotaDrop"`, and no `DROP`.

Run: `pnpm --filter @query-analyser/api exec prisma migrate dev && pnpm --filter @query-analyser/api db:generate`
Expected: the migration applies.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @query-analyser/api exec vitest run src/db.test.ts && pnpm --filter @query-analyser/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma apps/api/src/db.test.ts
git commit -m "feat(api): columns for sql signatures, errors, fine histograms and quota drops"
```

---

### Task 11: API — writer and compaction for SQL items

**Files:**
- Modify: `apps/api/src/ingest/writer.ts`, `apps/api/src/analysis/compaction.ts`
- Test: `apps/api/src/ingest/writer.test.ts`, `apps/api/src/analysis/compaction.test.ts`

**Interfaces:**
- Consumes: Task 10's columns; `IngestItem` SQL keys (Task 1).
- **Signature upsert:**
  - `sigRows` add `orm`, `database`, `sqlText: i.sql`, and `lastErrorCode` (the first `errorCodes` entry's code, or null), each `?? null`.
  - `ON CONFLICT` adds:
    - `"orm"`, `"model"` and `"operation"`, each `CASE WHEN "QuerySignature"."orm" IS NULL AND EXCLUDED."orm" IS NOT NULL THEN EXCLUDED.x ELSE "QuerySignature".x END`;
    - `"database"` and `"sqlText"` with `COALESCE(stored, EXCLUDED)`;
    - `"lastErrorCode" = COALESCE(EXCLUDED."lastErrorCode", "QuerySignature"."lastErrorCode")`.
- **Rollup upsert:**
  - `rollRows` add `errors: i.errors ?? 0`, `histFine: i.histFine ? '{…}' : '{}'` and `minSampleRate: i.sampleRate ?? null`.
  - On conflict:
    - `errors` adds;
    - `histFine = CASE WHEN cardinality(old) = 0 THEN EXCLUDED WHEN cardinality(EXCLUDED) = 0 THEN old ELSE element-wise sum END`;
    - `minSampleRate = LEAST(old, EXCLUDED)`, since `LEAST` ignores nulls.
- **`App.thresholdMs`:** a third statement, `UPDATE "App" SET "thresholdMs" = ${payload.thresholdMs} WHERE id = ${appId} AND "thresholdMs" IS DISTINCT FROM ${payload.thresholdMs}`.
- **`compactDay`:**
  - `errors` = `sum`;
  - `minSampleRate` = `min`;
  - `histFine` is summed element-wise over the hours whose `cardinality = 14`, and is `'{}'` when there are none (a second `exploded`/`hists` pair over `histFine`, joined with `LEFT JOIN … COALESCE(h2.hist_fine, '{}')`).

- [ ] **Step 1: Write the failing tests**

`writer.test.ts`, a new `describe('sql items')` (`sqlItem(over)` = a 0.4 item as in Task 1's `sqlItem`):

```ts
it('stores orm, database, sqlText and lastErrorCode on insert', async () => { /* row matches */ });
it('a 0.3 Mongo item stores nulls, errors 0 and an empty histFine', async () => { /* item() → orm null, histFine [] , errors 0, minSampleRate null */ });
it('label rule: a pg-first row is relabelled by the first prisma item, then never again', async () => {
  await write(sqlItem({ orm: undefined, model: 'users', operation: 'select' }));
  await write(sqlItem({ orm: 'prisma', model: 'User', operation: 'findMany' }));
  await write(sqlItem({ orm: 'prisma', model: 'User', operation: 'findFirst' }));
  expect(await sig()).toMatchObject({ orm: 'prisma', model: 'User', operation: 'findMany' });
});
it('accumulates errors and histFine, and keeps the lowest sample rate', async () => {
  // two writes in one hour: errors 1+2 → 3; histFine summed; sampleRate 0.5 then 0.1 → 0.1; then a write without sampleRate → still 0.1
});
it('a Mongo rollup and a SQL rollup in one batch each keep their own histFine', async () => { /* [] and 14 buckets */ });
it('records the payload thresholdMs on the app', async () => { /* thresholdMs 250 → App.thresholdMs 250 */ });
```

`compaction.test.ts`: `'sums errors and histFine and keeps the minimum rate over a day'`; and `'a day of Mongo rollups compacts with an empty histFine'`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/ingest/writer.test.ts src/analysis/compaction.test.ts`
Expected: FAIL. The new fields are not written.

- [ ] **Step 3: Implement** the writer and `compactDay` changes above.

- [ ] **Step 4: Run to verify they pass** (the same command), then `pnpm --filter @query-analyser/api typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingest/writer.ts apps/api/src/ingest/writer.test.ts apps/api/src/analysis/compaction.ts apps/api/src/analysis/compaction.test.ts
git commit -m "feat(api): store sql labels, errors and fine histograms with the label rule"
```

---

### Task 12: API — drop only new shapes at the quota, and record the drop

**Files:**
- Modify: `apps/api/src/ingest/routes.ts`, `apps/api/src/plugins/prisma.ts` (`ingestStats.droppedNew`)
- Test: `apps/api/src/ingest/routes.test.ts`, `apps/api/src/admin/routes.test.ts` (if it asserts the stats keys)

**Interfaces:**
- Consumes: `QuotaDrop` (Task 10), `IngestResponse` (Task 1).
- **The quota rule:**
  - `known` = the set of stored hashes among the batch's, read with `findMany({ select: { hash: true } })`.
  - `room = max(0, SIGNATURE_QUOTA - existingCount)`.
  - The new hashes are taken in first-appearance order: the first `room` are kept, and the rest go into `dropped`.
  - Items whose hash is in `dropped` are removed before `writeBatch`.
  - When `dropped.size > 0`: `INSERT INTO "QuotaDrop" … ON CONFLICT ("appId","bucketHour") DO UPDATE SET "droppedNew" = "QuotaDrop"."droppedNew" + EXCLUDED."droppedNew"`, with `bucketHour = bucketToDate(payload.bucket)`, and `app.ingestStats.droppedNew += dropped.size`.
  - Always `reply.code(202).send({ accepted: signatures, droppedNew: dropped.size })`. The quota never answers 429; rate-limit 429s are unchanged.
  - A batch whose items are all dropped still answers 202 with `accepted: 0`.

- [ ] **Step 1: Rewrite and add the tests**

- `'accepts a valid batch and writes it'` now expects `{ accepted: 2, droppedNew: 0 }`. Every other `{ accepted }` assertion in the file gains `droppedNew: 0`.
- The test `'429s when the app is over its signature quota'` is replaced by:

```ts
it('at the quota, drops new shapes, answers 202 with droppedNew and records the drop', async () => {
  // 5,000 stored → post 3 new → 202 { accepted: 0, droppedNew: 3 }; QuotaDrop { droppedNew: 3 } for bucket 2026092014; signature count 5,000
});
it('Review Focus: a 6,000-shape app stores every known item and the new ones up to the quota', async () => {
  // 4,990 stored; one batch: 50 known hashes + 1,000 new → 202 { accepted: 60, droppedNew: 990 };
  // the 50 known rollups exist, 10 new signatures exist (the first 10 in batch order), QuotaDrop 990; a second identical post → droppedNew 990 again, QuotaDrop 1,980
});
it('a 0.3 Mongo payload at the quota is partially accepted the same way', async () => { /* sdkVersion '0.3.0' items with source mongodb */ });
```

- The test `'still accepts a batch of already-known signatures at quota'` is kept, now expecting `{ accepted: 1, droppedNew: 0 }`.
- In `packages/sdk/src/transport.test.ts`, add `'a 202 with droppedNew is delivered, not retried'`: `fetchImpl` answers `202 {"accepted":0,"droppedNew":3}` → `send()` resolves `{ status: 'ok' }`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/ingest/routes.test.ts`
Expected: FAIL. The route still answers 429, and the body has no `droppedNew`.

- [ ] **Step 3: Implement** the rule above in `routes.ts`, and the counter in `plugins/prisma.ts` (with its interface field `droppedNew: number`).

- [ ] **Step 4: Run the API suite**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api typecheck`
Expected: all pass, including `ingest/e2e.test.ts` (SDK 0.1).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingest apps/api/src/plugins/prisma.ts apps/api/src/admin packages/sdk/src/transport.test.ts
git commit -m "feat(api): at the signature quota drop only new shapes and record the drop"
```

---

### Task 13: API — percentiles over either histogram, the advice gate, list, series and detail

**Files:**
- Modify: `apps/api/src/analysis/percentile.ts`, `apps/api/src/analysis/jobs.ts` (`refreshAdviceForApp`), `apps/api/src/analysis/routes.ts`, `packages/contract/src/wire.ts` (`RankedQueryRow`)
- Test: `apps/api/src/analysis/percentile.test.ts`, `jobs.test.ts`, `routes.test.ts`, `wire-equality.test.ts`

**Interfaces:**
- Produces:

```ts
// percentile.ts
export function percentileFromHist(hist: number[], maxMs: number, p: number, bounds: readonly number[] = HIST_BOUNDS): PercentileResult;
/** histFine when it has 14 buckets, else hist with HIST_BOUNDS. */
export function percentiles(hist: number[], histFine: number[] | null, maxMs: number): { p50: PercentileResult; p95: PercentileResult; p99: PercentileResult };
// routes.ts RankRow gains:
source: string; orm: string | null; database: string | null; errors: number; minSampleRate: number | null; histFine: number[] | null;
// contract RankedQueryRow gains the serialised equivalents (same names and types)
```

- **List** (`GET /v1/apps/:id/queries`):
  - Schema gains `source`, `orm` and `database`, each `z.string().min(1).max(255).optional()`, and `sort` gains `errors`.
  - SQL:
    - `COALESCE(s.source, 'mongodb') AS source`, `s.orm`, `s.database`;
    - `SUM(r.errors)::int AS errors`, `MIN(r."minSampleRate") AS "minSampleRate"`;
    - rank key `WHEN 'errors' THEN SUM(r.errors)::numeric`;
    - filters `(${source}::text IS NULL OR COALESCE(s.source,'mongodb') = ${source})`, the same for `s.orm` and `s.database`;
    - a second sub-select sums `histFine` over rollups with `cardinality = 14` and returns NULL when there are none.
  - The same changes go into the daily query.
  - Each item gains `source`, `orm`, `errors`, `sampled: minSampleRate !== null`, `sampleRate: minSampleRate` and `p50`/`p95`/`p99` from `percentiles`.
- **Series:** each point gains `errors`, `p50` and `p99` (from `percentiles` on that rollup).
- **Detail:** adds `orm`, `database`, `sqlText`, `lastErrorCode`, `errors`, `p50`, `histFine` (summed, or `null`), `sampled`, `sampleRate` and `thresholdMs` (the app's). `advice` is `null` when the stored source is set and isn't `mongodb`.
- **Advice job:** `refreshAdviceForApp`'s `findMany` adds `where: { appId, OR: [{ source: null }, { source: 'mongodb' }] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// percentile.test.ts
it('reads the fine histogram with its own bounds', () =>
  expect(percentileFromHist([0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4, 0.5, FINE_HIST_BOUNDS)).toEqual({ value: 3.5, basis: 'interpolated' }));
it('percentiles prefers histFine and falls back to hist', () => { /* histFine null → same as percentileFromHist(hist) */ });
// jobs.test.ts
it('writes no advice for a postgresql signature', async () => { /* source 'postgresql' with an eq filterShape → no Advice row */ });
// routes.test.ts
it('filters by source, orm and database, reading a null source as mongodb', async () => { /* 3 signatures → each filter returns its one */ });
it('a SQL row carries errors, sampled and p50/p95/p99 from histFine', async () => { /* rollup errors 2, minSampleRate 0.1 → errors 2, sampled true, sampleRate 0.1 */ });
it('a Mongo row has sampled false and percentiles from hist', async () => { /* … */ });
it('sorts by errors in SQL', async () => { /* 3 rows with errors 5, 1, 9 and limit 2 → 9, 5 */ });
it('400s a repeated source param', async () => { /* ?source=a&source=b → 400 */ });
it('detail of a SQL signature: sqlText, lastErrorCode, thresholdMs, advice null', async () => { /* … */ });
it('series points carry errors, p50 and p99', async () => { /* … */ });
```

Existing `toEqual` assertions on list items gain the new fields with their Mongo values (`source: 'mongodb'`, `orm: null`, `errors: 0`, `sampled: false`, `sampleRate: null`, `p50`, `p99`). They are extended, never weakened.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/contract build && pnpm --filter @query-analyser/api exec vitest run src/analysis`
Expected: FAIL on the new tests, and `wire-equality` fails to compile until both `RankRow` and `RankedQueryRow` change.

- [ ] **Step 3: Implement** the percentile, contract, job and route changes.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/contract build && caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/wire.ts apps/api/src/analysis
git commit -m "feat(api): sql filters, errors and fine percentiles on the read routes; mongo-only advice"
```

---

### Task 14: API — `GET /v1/apps/:id/summary`, per source and never combined

**Files:**
- Create: `apps/api/src/analysis/summary.ts`, `apps/api/src/analysis/summary.test.ts`
- Modify: `apps/api/src/analysis/routes.ts` (register the route with the `read` preHandler)

**Interfaces:**
- Produces:

```ts
export interface SourceSummary {
  source: string;                       // 'postgresql' | 'mongodb' | future values
  counts: 'all-statements' | 'slow-only'; // 'slow-only' for mongodb
  count: number; totalMs: bigint; avgMs: number; maxMs: number;
  p50: PercentileResult; p95: PercentileResult; p99: PercentileResult;
  slowCount: number;                    // sum of hist; equals count for mongodb
  errors: number; sampled: boolean; sampleRate: number | null;
}
export interface SummaryResponse { grain: 'hourly' | 'daily'; from: string; to: string; thresholdMs: number | null; droppedNew: number; sources: SourceSummary[] }
export async function summarise(prisma: PrismaClient, appId: string, w: { from: Date; to: Date; grain: 'hourly' | 'daily' }, f: { source: string | null; orm: string | null }): Promise<Omit<SummaryResponse, 'grain' | 'from' | 'to'>>;
```

- One SQL statement per grain groups by `COALESCE(s.source, 'mongodb')` and returns `count`, `totalMs::bigint`, `maxMs`, `errors`, `MIN(minSampleRate)`, the summed `hist` and the summed non-empty `histFine`.
- Percentiles use `percentiles(hist, histFine, maxMs)` (Task 13).
- `droppedNew` = the sum of `QuotaDrop.droppedNew` in the window. `thresholdMs` = `App.thresholdMs`.
- `sources` is ordered `postgresql` first, then `mongodb`, then any other alphabetically. **No field ever adds counts across sources.**
- Query parameters: `from`, `to`, `source` and `orm`, the same zod rules as the list. The window comes from `resolveWindow`.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns separate figures per source and no combined total', async () => {
  // seed: SQL count 100 (slow 3, errors 2, histFine) and Mongo count 7 → sources[0] { source: 'postgresql', counts: 'all-statements', count: 100, slowCount: 3, errors: 2 },
  // sources[1] { source: 'mongodb', counts: 'slow-only', count: 7, slowCount: 7 }; Object.keys(body) has no 'count' or 'total'
});
it('marks a source sampled when any rollup in the window has a rate below 1', async () => { /* minSampleRate 0.1 → sampled true, sampleRate 0.1 */ });
it('returns the quota drops in the window and the app threshold', async () => { /* QuotaDrop rows in and out of the window → only in-window summed; thresholdMs 100 */ });
it('filters by source and orm', async () => { /* ?source=mongodb → one entry */ });
it('reads daily rollups for a window longer than seven days', async () => { /* grain 'daily' */ });
it('403s a user without access and 400s an inverted window', async () => { /* … */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/analysis/summary.test.ts`
Expected: FAIL, 404 or module not found.

- [ ] **Step 3: Implement** `summary.ts` and the route.

- [ ] **Step 4: Verify**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/analysis
git commit -m "feat(api): per-source summary with quota drops and the app's slow threshold"
```

---

## Step B: web

### Task 15: Web — types, Database and ORM filters, and SQL in the list

**Files:**
- Modify: `apps/web/src/dashboard-types.ts`, `src/filters.ts`, `src/queries-view.ts`, `components/dashboard/QueryFilters.tsx`, `components/dashboard/QueriesTable.tsx`, `app/dashboard/[org]/[app]/queries/page.tsx`
- Create: `apps/web/src/sources.ts`
- Test: `apps/web/src/filters.test.ts`, `src/queries-view.test.ts`, `components/dashboard/QueriesTable.test.tsx`

**Interfaces:**
- Consumes: the list JSON from Task 13.
- Produces:
  - `QueryRow = Omit<Serialized<RankedQueryRow>, 'hist' | 'histFine' | 'minSampleRate' | 'source' | 'orm' | 'database' | 'errors'> & { avgMs: number; p95: PercentileResult; source?: string; orm?: string | null; errors?: number; sampled?: boolean; sampleRate?: number | null; p50?: PercentileResult; p99?: PercentileResult }`. The SQL fields are optional, so a web build stays type-compatible with an API that has not been redeployed.
  - `QueryListResponse.sort` gains `'errors'`.
  - `QueryFilters` gains `source?: string` and `orm?: string`, parsed with `firstValue`, kept in `filtersToSearch`, and sent by `filtersToApiQuery`. `SortKey` gains `'errors'` (label `Errors`).
  - `sources.ts`:

```ts
export const SOURCE_LABEL: Record<string, string>;   // { postgresql: 'PostgreSQL', mongodb: 'MongoDB' }; unknown → the raw value
export function sourceLabel(source: string | undefined): string;            // undefined → 'MongoDB'
export function ormLabel(source: string | undefined, orm: string | null | undefined): string; // prisma → 'Prisma'; mongodb → 'Mongoose / driver'; SQL with no orm → 'pg'
export function sampledLabel(rate: number | null | undefined): string | null; // 0.1 → 'estimated (sampled at 10%)'; null/1 → null
```

  - `RowView` gains `source: string; sourceLabel: string; ormLabel: string; errors: number; sampledLabel: string | null`.
- The table gains a source badge (`sourceLabel · ormLabel`) under the title, and an `Errors` column after `Calls`. A sampled row shows `sampledLabel` as a muted line under its call count.
- The page:
  - Database options = distinct `r.source ?? 'mongodb'`; ORM options = distinct non-null `r.orm`. Both come from the unfiltered window, as model and op do today.
  - `filtered` includes `source` and `orm`.
  - `clearFiltersHref` drops them.

- [ ] **Step 1: Write the failing tests**

```ts
// filters.test.ts
it('parses, round-trips and sends source and orm', () => {
  const f = parseFilters({ source: 'postgresql', orm: 'prisma' });
  expect(filtersToSearch(f)).toBe('source=postgresql&orm=prisma');
  expect(new URLSearchParams(filtersToApiQuery(f, NOW)).get('orm')).toBe('prisma');
});
it('accepts sort=errors', () => expect(parseFilters({ sort: 'errors' }).sort).toBe('errors'));
// queries-view.test.ts
it('labels a SQL row and a Mongo row from an older API', () => {
  const [sql, mongo] = toRowsView([row({ source: 'postgresql', orm: 'prisma', errors: 2, sampleRate: 0.1, sampled: true }), row({})]);
  expect(sql).toMatchObject({ sourceLabel: 'PostgreSQL', ormLabel: 'Prisma', errors: 2, sampledLabel: 'estimated (sampled at 10%)' });
  expect(mongo).toMatchObject({ sourceLabel: 'MongoDB', ormLabel: 'Mongoose / driver', errors: 0, sampledLabel: null });
});
it('clearFiltersHref drops source and orm', () => { /* … */ });
// QueriesTable.test.tsx
it('shows the source badge, an Errors column and the sampled label', () => { /* getByText('PostgreSQL · Prisma'), columnheader 'Errors', getByText('estimated (sampled at 10%)') */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run src/filters.test.ts src/queries-view.test.ts components/dashboard/QueriesTable.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the types, `sources.ts`, filters, view, filter bar (two more `SingleSelect`s labelled `Database` and `ORM`; Database shows `sourceLabel` for each value), table and page.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/components/dashboard "apps/web/app/dashboard/[org]/[app]/queries/page.tsx"
git commit -m "feat(web): database and orm filters, errors and sampled labels in the query list"
```

---

### Task 16: Web — the per-source summary strip and the quota notice

**Files:**
- Create: `apps/web/components/dashboard/SummaryStrip.tsx`, `SummaryStrip.test.tsx`
- Modify: `apps/web/src/dashboard-types.ts` (`SummaryResponse`, `SourceSummary` with `totalMs: string`), `src/dashboard-api.ts` (`getSummary`), `app/dashboard/[org]/[app]/queries/page.tsx`

**Interfaces:**
- Produces:
  - `getSummary(t: string, app: string, apiQuery: string): Promise<ApiResult<SummaryResponse>>`, which calls `/v1/apps/${app}/summary?${apiQuery}`;
  - `summaryApiQuery(f: QueryFilters, now?: Date, retentionDays?: number): string` in `src/filters.ts`, giving `from`, `to`, and `source`/`orm` when set (no sort, limit or offset). It is tested in `src/filters.test.ts` with `'summary query carries the window and source/orm only'`;
  - `SummaryStrip({ summary }: { summary: SummaryResponse })`.
- **Copy, verbatim:**
  - Group heading: the source label, plus ` · estimated (sampled at N%)` when sampled.
  - PostgreSQL cards: `Statements`, `Avg`, `P50`, `P95`, `P99`, `Slow (≥ {threshold} ms)`, `Errors`.
  - MongoDB cards: `Slow queries (≥ {threshold} ms)`, `Avg`, `P95`.
  - `{threshold}` is `summary.thresholdMs`; when it is null, the label reads `Slow (≥ threshold)` or `Slow queries (≥ threshold)`.
  - Quota notice, when `droppedNew > 0`: `{n} new query shapes were not recorded in this window because this app reached its limit of 5,000. Queries already seen are still counted.`
- The page fetches the summary in parallel with the list. A failed summary hides the strip and never fails the page.

- [ ] **Step 1: Write the failing tests**

```ts
it('renders one group per source and never a combined total', () => {
  render(<SummaryStrip summary={both} />);  // postgresql count 100, mongodb count 7
  expect(screen.getByRole('region', { name: 'PostgreSQL' })).toBeTruthy(); expect(screen.getByRole('region', { name: 'MongoDB' })).toBeTruthy();
  expect(screen.queryByText('107')).toBeNull();
  expect(screen.getByText('Slow queries (≥ 100 ms)')).toBeTruthy();
});
it('labels a sampled source', () => { /* sampled 0.1 → 'PostgreSQL · estimated (sampled at 10%)' */ });
it('shows the quota notice only when shapes were dropped', () => { /* droppedNew 3 → the verbatim text with 3; 0 → absent */ });
it('falls back to the word threshold when none is stored', () => { /* thresholdMs null → 'Slow (≥ threshold)' */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run components/dashboard/SummaryStrip.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** the component (each group a `<section aria-label={label}>` of `StatCard`s), `getSummary`, and the page wiring above the filter bar.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/components/dashboard "apps/web/app/dashboard/[org]/[app]/queries/page.tsx"
git commit -m "feat(web): per-source summary strip and the quota-drop notice"
```

---

### Task 17: Web — the SQL detail view

**Files:**
- Create: `apps/web/components/dashboard/SqlQueryDetail.tsx`, `SqlQueryDetail.test.tsx`
- Modify: `apps/web/src/dashboard-types.ts` (`QueryDetail`, `SeriesPoint`), `src/hist.ts`, `src/detail-view.ts`, `components/dashboard/TrendChart.tsx`, `app/dashboard/[org]/[app]/queries/[sig]/page.tsx`
- Test: `apps/web/src/hist.test.ts`, `src/detail-view.test.ts`

**Interfaces:**
- Produces:
  - `QueryDetail` gains, all optional: `orm`, `database`, `sqlText`, `lastErrorCode` (each `string | null`), `errors: number`, `p50: PercentileResult`, `histFine: number[] | null`, `sampled: boolean`, `sampleRate: number | null` and `thresholdMs: number | null`.
  - `SeriesPoint` gains `errors?`, `p50?` and `p99?`.
  - `histLabels(bounds: readonly number[] = HIST_BOUNDS): string[]`, and `histogramData(hist: number[], bounds?: readonly number[])`.
  - `trendData` points gain `errors: number | null`, so `TrendChart` draws an `Errors` series when any point has errors.
  - `SqlQueryDetail({ detail, series, rangeLabel }: { detail: QueryDetail; series: SeriesResponse | null; rangeLabel: string })`.
- **The view:**
  - The full `sqlText ?? signature` in a monospaced `<pre>` with a `CopyButton` (label `Copy the SQL`).
  - Stat cards: `Calls`, `Total time`, `Avg`, `P50`, `P95`, `P99`, `Max`, and `Errors` with the hint `last SQLSTATE {code}` when `lastErrorCode` is set.
  - A metadata list: `Database`, `Table` (the `collection`), `ORM` (`ormLabel`) and `Operation` (`model.operation`).
  - The latency histogram uses `histFine` with `FINE_HIST_BOUNDS` when present, else `hist`.
  - The trend shows calls, P95 and errors.
  - When sampled, a muted `estimated (sampled at N%)` line under the stats.
  - No `AdviceCard` and no `CompassQuery`.
- **The page** renders `SqlQueryDetail` when `(d.source ?? 'mongodb') !== 'mongodb'`. Otherwise it renders today's Mongo view, unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// hist.test.ts
it('labels the fine buckets', () => expect(histLabels(FINE_HIST_BOUNDS)).toEqual(['< 1ms', '1–2ms', '2–5ms', '5–10ms', '10–25ms', '25–50ms', '50–100ms', '100–250ms', '250–500ms', '500ms–1s', '1–2.5s', '2.5–5s', '5–10s', '≥ 10s']));
it('the default is still the 8 Mongo buckets', () => expect(histLabels()).toHaveLength(8));
// detail-view.test.ts
it('trend points carry errors, and null where there were no calls', () => { /* … */ });
// SqlQueryDetail.test.tsx
it('shows the full SQL, the stats, the last SQLSTATE and the metadata', () => {
  render(<SqlQueryDetail detail={sqlDetail} series={null} rangeLabel="last 24h" />);
  expect(screen.getByText(sqlDetail.sqlText!)).toBeTruthy(); expect(screen.getByText('last SQLSTATE 23505')).toBeTruthy();
  expect(screen.getByText('Prisma')).toBeTruthy(); expect(screen.getByText('User.findMany')).toBeTruthy();
  expect(screen.queryByText(/createIndex|Compass/)).toBeNull();
});
it('uses the fine histogram when present', () => { /* 14 bars */ });
it('labels a sampled detail', () => { /* 'estimated (sampled at 10%)' */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run src/hist.test.ts src/detail-view.test.ts components/dashboard/SqlQueryDetail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the types, the `hist`/`detail-view` changes, the `TrendChart` errors series, the component and the page switch.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web typecheck && pnpm --filter @query-analyser/web build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/components/dashboard "apps/web/app/dashboard/[org]/[app]/queries/[sig]/page.tsx"
git commit -m "feat(web): sql detail view with full sql, errors and fine latency"
```

---

## Step C: compatibility and regression tests

### Task 18: Compat — every `pg` 8 minor against a real Postgres

**Files:**
- Modify: `packages/sdk-compat/package.json`
- Create: `packages/sdk-compat/src/pg-harness.ts`, `packages/sdk-compat/src/pg.test.ts`

**Interfaces:**
- Consumes: `createThrowawayDb` (Task 9, via `../../sdk/src/__tests__/pg-db.js`); `init`, `shutdown` and `installPgWrap` from the SDK source.
- Produces:
  - devDependencies: `pg800: npm:pg@8.0.3`, `pg804: npm:pg@8.4.2`, `pg807: npm:pg@8.7.3`, `pg811: npm:pg@8.11.6`, `pg813: npm:pg@8.13.3`, `pg816: npm:pg@8.16.3`, `pg820: npm:pg@8.20.0`, `pg823: npm:pg@8.23.1`;
  - `pg-harness.ts`: `PGS: { minor: string; mod: typeof import('pg') }[]` (8 entries, each asserting `require('<alias>/package.json').version` matches), plus `capture()` reused from `harness.ts`.

- [ ] **Step 1: Write `pg.test.ts`**

It runs `describe.each(PGS)('pg %s', …)`. Each suite gets a throwaway database, calls `init({ thresholdMs: 0, fetchImpl })`, and then `installPgWrap(mod.Client)`, because the alias isn't the copy `init()` resolves.

```ts
it('every form passes through the wrapper exactly once', async () => { /* Pool.query, PoolClient.query, Client.query, cb, promise, config, rowMode array, named twice → total count 9 */ });
it('an ignored failing promise raises one unhandledRejection with the same error', async () => { /* as in Task 5, real server, missing table → code 42P01 */ });
it('results and errors are identical with and without the SDK', async () => { /* … */ });
it('a submittable (new mod.Query) is untouched and uncounted', async () => { /* … */ });
it('client.database is the throwaway db name', async () => { /* item.database === db.name */ });
it('never sends a value', async () => { /* canaries as in Task 9 */ });
```

- [ ] **Step 2: Run**

Run: `pnpm install && pnpm --filter @query-analyser/contract build && pnpm --filter @query-analyser/sdk-compat exec vitest run src/pg.test.ts`
Expected: 8 suites pass. A failure on one minor is fixed in the SDK source, never by dropping that minor. No `qa_sdk_%` database is left afterwards (the `psql` check from Task 9).

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-compat pnpm-lock.yaml
git commit -m "test(sdk): pg 8.0-8.23 compatibility matrix against postgres"
```

---

### Task 19: Compat — Prisma 5.22, 6.0, 6.19 and 7.10 on the adapter and engine paths

**Files:**
- Create: `packages/sdk-compat/scripts/prisma-setup.mjs`, `packages/sdk-compat/prisma-fixtures/.gitignore` (`*/node_modules`, `*/generated`, `*/package-lock.json`)
- Create: `packages/sdk-compat/prisma-fixtures/<name>/package.json`, `schema.prisma`, and `prisma.config.ts` for the 7 fixtures
- Create: `packages/sdk-compat/src/prisma-harness.ts`, `packages/sdk-compat/src/prisma.test.ts`
- Modify: `packages/sdk-compat/package.json` (`"prisma:setup": "node scripts/prisma-setup.mjs"`)

**Interfaces:**
- **Fixtures** (exact versions; `prisma`, `@prisma/client`, `@prisma/adapter-pg` and `@prisma/instrumentation` all at the Prisma version):

| name | Prisma | app `pg` | `previewFeatures` | extra client |
|---|---|---|---|---|
| `p522` | 5.22.0 | 8.11.6 | `driverAdapters` | `tracing` (`driverAdapters`, `tracing`) |
| `p601` | 6.0.1 | 8.13.3 | `driverAdapters` | `tracing` |
| `p619` | 6.19.3 | 8.16.3 | none | — |
| `p710` | 7.10.1 | 8.23.1 | none (`prisma.config.ts`) | — |
| `p710-private` | 7.10.1 | 8.11.6 (the adapter gets a private 8.23.x) | none | — |

  Each fixture also pins `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` and `@opentelemetry/context-async-hooks` at the latest versions that satisfy that `@prisma/instrumentation`'s peer ranges.
- **Schema** (every fixture): `User` (`id`, `email @unique`, `name`, `posts`), `Post` (`id`, `title`, `views Int`, `authorId`, `tags`), `Tag` (`id`, `name @unique`, implicit m-n with `Post`) and `Product` (`id`, `sku @unique`, `name`, `price Int`). The generator's `output = "./generated/client"` (`./generated/tracing` for the extra client).
- **`prisma-setup.mjs`:** for each fixture, `npm install --ignore-scripts --no-audit --no-fund --no-package-lock`, then that fixture's own CLI (`node node_modules/prisma/build/index.js generate`, once per schema file). It prints `ready <name> prisma <version>` for each fixture.
- **`prisma-harness.ts`:**

```ts
export const FIXTURES: readonly { name: string; major: 5 | 6 | 7; dir: string; hasTracingClient: boolean }[];
export function load(fx: { dir: string }, client?: 'client' | 'tracing'): { PrismaClient: any; PrismaPg: any; pg: any; adapterPg: any; instrumentation: any; otel: { api: any; base: any; ctx: any } };
export async function pushSchema(fx: { dir: string }, url: string): Promise<void>; // the fixture's CLI `db push` (adds --skip-generate on 5/6), DATABASE_URL in env, output discarded
export const WORKLOAD: readonly { label: string; run(p: any): Promise<unknown> }[]; // 12 calls: create, findUnique, findMany include, count, aggregate, groupBy, updateMany, upsert, createMany, $transaction([count, count]), interactive $transaction, $queryRaw
export function referenceCount(queryEvents: { query: string }[]): number; // events whose first keyword is a captured verb; reads only `query`
export function resolverAt(dir: string): (name: string) => string | null; // createRequire(join(dir, 'x.js')).resolve(name), null on failure
```

- **Wiring in each test:** `init({ thresholdMs: 0, fetchImpl, pg: fx.pg })`; then `const r = resolvePgClients(fx.pg, { appEntry: resolverAt(fx.dir) })` (Task 6), `installPgWrap` for each of `r.clients`, and `sqlRuntime().prismaAdapterResolved = r.adapterResolved`. The aliased fixture copies aren't the ones `init()` resolves from the SDK's own location.
- The reference counter is Prisma's own `$on('query')` with `log: [{ emit: 'event', level: 'query' }]`. The test reads only `e.query`.

- [ ] **Step 1: Set up the fixtures**

Run: `pnpm --filter @query-analyser/sdk-compat prisma:setup`
Expected: five `ready` lines, with versions 5.22.0, 6.0.1, 6.19.3, 7.10.1 and 7.10.1.

- [ ] **Step 2: Write `prisma.test.ts`**

`beforeAll` checks that each fixture's `generated/client` exists, or fails with `run pnpm --filter @query-analyser/sdk-compat prisma:setup`. Each fixture gets its own throwaway database plus `pushSchema`.

`describe.each(FIXTURES)('$name adapter path', …)`:

```ts
it('exactly once: N Prisma calls and M raw pg queries on the shared pool equal the reference count', async () => {
  // WORKLOAD on new PrismaClient({ adapter: new PrismaPg(pool), log }) + 5 pool.query(...) → sum(counts) === referenceCount(events) + 5
});
it('labels: Prisma 7 statements carry model and operation; 5/6 carry orm prisma with the table as model', async () => {
  // 7: the item for findUnique has { orm: 'prisma', model: 'User', operation: 'findUnique' }
  // 5.22/6.0/6.19: { orm: 'prisma', model: 'User', operation: 'select' } (Decision 5)
  // $transaction([user.count, product.count]): both statements carry the first operation's label (documented)
});
it('the SQL sent is unchanged: no pg-captured text contains traceparent, and texts equal a run without the SDK', async () => { /* … */ });
it('two SDK copies loaded at once still count each statement once', async () => { /* vi.resetModules + import the SDK source twice → same total */ });
```

`describe('p710-private')`:

```ts
it('Review Focus: the adapter\'s private pg copy is found and every statement counted once', async () => {
  // new PrismaPg({ connectionString }) (config form) → resolvePgClients finds 2 classes; WORKLOAD → sum === referenceCount
});
```

`describe.each(FIXTURES.filter((f) => f.major < 7))('$name engine path', …)`:

```ts
it('without app tracing: no SQL items, the SQL is unchanged, nothing throws', async () => {
  // PrismaClient without adapter; WORKLOAD → zero postgresql items; $on('query') texts contain no 'traceparent'
});
it('with the app\'s own tracing and an always-on sampler: every statement once, labelled orm prisma', async () => {
  // 6.19: new PrismaInstrumentation().enable() + a BasicTracerProvider with AlwaysOnSampler and an in-memory exporter, registered before the client;
  // 5.22/6.0: the `tracing` client plus the same provider → sum(counts) === referenceCount(events)
});
it('with a 50% ratio sampler: at most the reference, and the app\'s exported spans are the same with and without the SDK', async () => { /* … */ });
```

`describe.each(FIXTURES.filter((f) => f.major < 7))('$name adapter path with app tracing', …)`:

```ts
it('engine db_query spans with a js:query child are skipped, so pg counts each statement once', async () => { /* sum === referenceCount */ });
```

- [ ] **Step 3: Run**

Run: `pnpm --filter @query-analyser/sdk-compat exec vitest run src/prisma.test.ts`
Expected: all pass. Then record one raw SQL text per corpus case from each line (5.22 engine, 6.19 engine, 7.10 adapter) into `packages/sdk/src/sql/corpus.test.ts` (Task 2), and run `pnpm --filter @vivekumar08/query-analyser exec vitest run src/sql/corpus.test.ts`. Expected: PASS. A mismatch means the corpus inputs are corrected; a hash change across Prisma minors is expected (Decision 6).

- [ ] **Step 4: Run the whole compat package**

Run: `pnpm --filter @query-analyser/sdk-compat test && pnpm --filter @query-analyser/sdk-compat typecheck`
Expected: all pass, and no `qa_sdk_%` database is left.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-compat packages/sdk/src/sql/corpus.test.ts
git commit -m "test(sdk): prisma 5.22-7.10 compatibility on adapter and engine paths"
```

---

### Task 20: Compat — SQL overhead benchmark

**Files:**
- Create: `packages/sdk-compat/src/sql-overhead.test.ts`
- Modify: `packages/sdk-compat/package.json` (`bench` runs both overhead files)

**Interfaces:**
- Consumes: `pg-harness.ts`, `prisma-harness.ts`, and `createThrowawayDb`.
- Produces: a `console.table` with the columns `stack`, `workload`, `offUsPerOp`, `sdkRate1UsPerOp`, `sdkRate01UsPerOp`, `addedPctRate1`. Task 22 copies it into the changelog.

- [ ] **Step 1: Write the benchmark**

`describe.runIf(process.env.QA_BENCH === '1')('sql overhead', …)`, one test `'reports off / sdk at rate 1 / sdk at rate 0.1 per operation'`.
- Seed 1,000 rows.
- Stacks and workloads:
  - `pg823`: `pool.query('SELECT * FROM t WHERE id = $1', [id]) ×5000`;
  - `p710`, `p619` and `p522` on the adapter path: `user.findUnique ×3000`.
- 300 warm-up calls. The median of 5 runs, in µs per operation. `thresholdMs` is 100.
- No assertion beyond `expect(rows).toHaveLength(4)`; the design sets no pass/fail number.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @query-analyser/sdk-compat bench`
Expected: the Mongo and SQL benchmarks pass, and a 4-row SQL table is printed. For scale, spike Q2 measured Prisma 7.10.1 `findUnique` at 76.9 µs without a helper and 81.3 µs with one.

Run: `pnpm --filter @query-analyser/sdk-compat test`
Expected: both benchmarks are skipped and everything else passes.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-compat
git commit -m "test(sdk): benchmark the cost of pg and prisma capture"
```

---

## Step D: release prep (0.4.0)

### Task 21: Web — PostgreSQL and Prisma in the homepage and onboarding copy

**Files:**
- Modify: `apps/web/app/page.tsx:47`, `apps/web/components/onboarding/InstallStep.tsx` (the help list at `:196-197`), `apps/web/components/onboarding/snippet.ts`
- Test: `apps/web/src/homepage.test.tsx`, `apps/web/src/snippet.test.ts`, `apps/web/components/onboarding/InstallStep.test.tsx`

**Interfaces:**
- **Copy, verbatim:**
  - Homepage eyebrow: `For MongoDB and PostgreSQL · Mongoose 6–9 · Prisma 5.22–7 · pg 8`.
  - The snippet's first line: `// Call this before your app connects to its database.`
  - Help items replacing the two at `:196-197`:
    - `Your app uses Mongoose 6–9, the MongoDB Node.js driver 4–7, pg 8, or Prisma 5.22–7 on PostgreSQL.`
    - `Prisma 5 or 6 needs @prisma/adapter-pg (Prisma 7 always uses an adapter).`
    - `init() runs before your app connects to MongoDB, or the connection sets monitorCommands: true.`
- `driverCode` is unchanged.

- [ ] **Step 1: Update the tests** to the strings above: the homepage eyebrow, the snippet's first line, and `InstallStep` `getByText` for each help item.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run src/homepage.test.tsx src/snippet.test.ts components/onboarding/InstallStep.test.tsx`
Expected: FAIL on the new copy.

- [ ] **Step 3: Implement** the copy.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web typecheck && pnpm --filter @query-analyser/web build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/page.tsx apps/web/components/onboarding apps/web/src/homepage.test.tsx apps/web/src/snippet.test.ts
git commit -m "feat(web): name postgresql, prisma and pg in the homepage and onboarding"
```

---

### Task 22: SDK — prepare 0.4.0: version, README, changelog (no publish)

**Files:**
- Modify: `packages/sdk/package.json` (`"version": "0.4.0"`; `description`: `Find your slow MongoDB and PostgreSQL queries. One line of setup.`; `keywords` gain `postgresql`, `postgres`, `pg`, `prisma`, `sql`), `packages/sdk/README.md`, `packages/sdk/CHANGELOG.md`

**Interfaces:**
- Consumes: Task 20's table. `SDK_VERSION` follows `package.json` (`'SDK_VERSION matches package.json'` already pins it).

- [ ] **Step 1: README**
  - **"PostgreSQL: pg and Prisma"** (new section, after "Using the mongodb driver"):
    - `pg` and Prisma 7: nothing to add beyond `init()`. Clients and pools created before `init()` are covered.
    - Prisma 5.22 and 6.x: use `@prisma/adapter-pg`, adding `previewFeatures = ["driverAdapters"]` where that version needs it.
    - Without the adapter, queries run inside Prisma's engine, and the SDK captures them only when your app already enables Prisma tracing (its own `@prisma/instrumentation`). The SDK never turns tracing on and never adds `traceparent` comments, so the SQL your database receives is exactly what your app sends. Quote Decision 18's warning and say what to do about it.
    - A bundled `pg` the SDK cannot resolve: `init({ pg })`, or `instrument(pool)`.
  - **Supported versions:** `pg >=8.0 <9` (tested 8.0.3–8.23.1); Prisma 7.x (tested 7.10.1); 6.x (tested 6.0.1 and 6.19.3) and 5.22 (tested 5.22.0), each with the adapter, or on the engine path with the app's own tracing. Prisma 8 is not supported.
  - **What is timed:** the statement's round trip from `query()` to its result, including the client's own queue and excluding pool checkout.
  - **What is counted:**
    - every SQL statement; `thresholdMs` defines "slow";
    - `sql.sampleRate`, and what "estimated (sampled at N%)" means: slow statements and failures are never sampled;
    - MongoDB stays slow-only, and its counts are never added to SQL counts.
  - **Masking:** `sql.maskIdentifiers` hides names and is not encryption, and turning it on starts new history.
  - **Known limitations,** one bullet each:
    - a Prisma upgrade, including 6.x minors, can start new history for some queries;
    - identical SQL from two Prisma methods carries the first label, so the ORM and Operation filters can under-report;
    - `$transaction([...])` and batched calls carry the first operation's label;
    - on Prisma 5/6 with the adapter, the model comes from the SQL table and the operation from the SQL verb, and the `prisma` label is inferred from the adapter's call shape;
    - with your own Prisma tracing, labels (adapter path) or statements (engine path) cover only the operations your sampler keeps;
    - on the engine path, failed statements are not counted as errors;
    - the same SQL on two databases is one row, showing the first database;
    - `pg-native`, `pg-cursor` and `pg-query-stream` are not timed;
    - Prisma Accelerate (`prisma://`) is not visible.
  - **"What leaves your process":** add the SQL keys and state that parameter values, results, error messages and connection strings never do.
  - **Options table:** add `pg` and `sql`.
- [ ] **Step 2: `CHANGELOG.md`**, a `## 0.4.0` section stating:
  - PostgreSQL capture for `pg` 8 and Prisma 5.22–7, with exactly one event per statement;
  - the new optional peers;
  - SQL fingerprints with values removed;
  - errors, P50/P99 and the fine histogram;
  - `sql.sampleRate` and `sql.maskIdentifiers`;
  - the API's new quota behaviour (fewer 429s; only new shapes are dropped);
  - Task 20's table;
  - Mongo payloads and hashes are unchanged from 0.3;
  - deploy the API and web before publishing, because older APIs ignore the SQL keys.
- [ ] **Step 3: Verify the release candidate**

Run: `pnpm --filter @query-analyser/contract build && pnpm --filter @vivekumar08/query-analyser build && pnpm --filter @vivekumar08/query-analyser typecheck && pnpm --filter @vivekumar08/query-analyser test && cd packages/sdk && npm pack --dry-run && cd ../.. && grep -n "traceparent" packages/sdk/README.md`
Expected:
- everything passes;
- `npm pack --dry-run` lists `CHANGELOG.md`, `LICENSE`, `README.md`, `dist/index.cjs`, `dist/index.d.cts`, `dist/index.d.ts`, `dist/index.js` and `package.json`, with version `0.4.0`;
- `grep` prints exactly the one line saying the SDK never adds `traceparent` comments.

Then run the whole repo: `caffeinate -i pnpm test && pnpm typecheck`
Expected: all packages pass.

- [ ] **Step 4: Commit (do not publish)**

```bash
git add packages/sdk/package.json packages/sdk/README.md packages/sdk/CHANGELOG.md
git commit -m "chore(sdk): prepare 0.4.0: readme, changelog and version"
```

Publishing `@vivekumar08/query-analyser@0.4.0` waits for the user's go-ahead, after the API and web are deployed.
