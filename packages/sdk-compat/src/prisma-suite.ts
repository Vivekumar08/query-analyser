import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { init, shutdown } from '../../sdk/src/index.js';
import { resolvePgClients } from '../../sdk/src/drivers.js';
import { installPgPoolWrap, installPgWrap } from '../../sdk/src/integrations/pg.js';
import { pgCoversAdapter } from '../../sdk/src/integrations/prisma.js';
import { sqlRuntime } from '../../sdk/src/sql/context.js';
import { createThrowawayDb, pgAvailable } from '../../sdk/src/__tests__/pg-db.js';
import { capture, itemsOf, sqlOf, sum, type PgItem } from './pg-harness.js';
import { FIXTURES, WORKLOAD, load, pushSchema, referenceCount, resolverAt, type Fixture, type Loaded } from './prisma-harness.js';

/**
 * Shared suite plumbing for the Prisma compat files (Task 19): prisma.test.ts (adapter path, p710-private,
 * isEnabled() false, Accelerate) and one prisma-engine-<name>.test.ts per library-engine fixture, so each
 * Prisma 5.22/6.0/6.19 query engine loads in its own vitest worker and a stall in one cannot hold another.
 *
 * Each fixture is its own npm project (`pnpm --filter @query-analyser/sdk-compat prisma:setup`) and gets its
 * own throwaway database per file, schema pushed with its own CLI, dropped in afterAll.
 *
 * Wiring, as init() does it for a resolved copy: init({ pg: fx.pg }), then resolvePgClients from the
 * fixture's own location (the aliased fixture copies are not what init() resolves from the SDK), each
 * class wrapped, and the runtime's adapter flags set from that result.
 *
 * The reference count is Prisma's own `$on('query')` (log level `query`, emitted as events); the tests
 * read only `e.query`, never `params`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Per-test timeout: a stalled engine or connection fails in 30 s instead of hanging the run. */
export const TEST_TIMEOUT_MS = 30_000;
export const SUITE = { timeout: TEST_TIMEOUT_MS };

export const available = await pgAvailable();
if (!available.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[prisma compat] skipped: no reachable Postgres (${available.reason}). Set QA_PG_URL or apps/api/.env DATABASE_URL.`);
}

export type Db = Awaited<ReturnType<typeof createThrowawayDb>>;
export type Item = PgItem & { orm?: string };

export const SETUP_HINT = 'run pnpm --filter @query-analyser/sdk-compat prisma:setup';
export const dbs = new Map<string, Promise<Db>>();

/** The fixture's throwaway database with its schema pushed (created once per fixture). */
export function dbFor(fx: Fixture): Promise<Db> {
  let p = dbs.get(fx.name);
  if (p === undefined) {
    p = (async () => {
      const db = await createThrowawayDb(`compat_prisma_${fx.name.replace(/-/g, '_')}`);
      try {
        await pushSchema(fx, db.url);
      } catch (e) {
        await db.drop().catch(() => {});
        throw e;
      }
      return db;
    })();
    dbs.set(fx.name, p);
  }
  return p;
}

/** Things each test opened: Prisma clients, pg pools, OTel registrations, test-only patches. */
export const cleanups: (() => unknown)[] = [];
export const later = (fn: () => unknown): void => { cleanups.push(fn); };

export async function cleanup(): Promise<void> {
  await shutdown();
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
}

/** Fails with the setup hint when a fixture's generated client is missing (Postgres or not). */
export function requireFixtures(): void {
  const missing = FIXTURES.filter((fx) => !existsSync(join(fx.dir, 'generated', 'client')));
  if (missing.length > 0) throw new Error(`prisma fixtures not set up (${missing.map((f) => f.name).join(', ')}): ${SETUP_HINT}`);
}

/**
 * The hooks every Prisma compat file registers: the fixture check, per-test cleanup, and the
 * throwaway databases dropped at the end (every drop attempted, even when one fails).
 */
export function registerPrismaHooks(): void {
  beforeAll(requireFixtures);
  afterEach(cleanup, 60_000);
  afterAll(async () => {
    await cleanup();
    const results = await Promise.allSettled([...dbs.values()].map(async (p) => {
      const db = await p.catch(() => null);
      await db?.drop();
    }));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) throw new Error(`prisma compat: ${failed.length} throwaway database drop(s) failed`);
  }, 120_000);
}

/** init() plus the fixture-rooted pg wiring. Returns the analyser, its captured bodies and onError reports. */
export function start(fx: Fixture, L: Loaded) {
  const cap = capture();
  const errors: Error[] = [];
  const a = init({ apiKey: 'k', app: `compat-${fx.name}`, thresholdMs: 0, fetchImpl: cap.fetchImpl, pg: L.pg, onError: (e) => { errors.push(e); } });
  const r = resolvePgClients(L.pg, { appEntry: resolverAt(fx.dir) });
  for (const C of r.clients) installPgWrap(C);
  for (const P of r.pools) installPgPoolWrap(P);
  const rt = sqlRuntime();
  rt.prismaAdapterResolved = r.adapterResolved;
  rt.pgCoversPrismaAdapter = pgCoversAdapter(r.adapterResolved, r.adapterPg);
  return { a, cap, errors, r, items: (): Item[] => itemsOf(cap.bodies) as Item[] };
}

/** A Prisma client with query events on; `events` holds only each event's `query`. */
export function prisma(L: Loaded, opts: Record<string, unknown>, which: 'client' | 'tracing' = 'client', fx?: Fixture) {
  const Ctor = which === 'client' ? L.PrismaClient : load(fx!, 'tracing').PrismaClient;
  const p = new Ctor({ ...opts, log: [{ emit: 'event', level: 'query' }] });
  const events: { query: string }[] = [];
  p.$on('query', (e: { query: string }) => { events.push({ query: e.query }); });
  later(() => p.$disconnect());
  return { p, events };
}

/** An app pool on the fixture's own pg. */
export function appPool(L: Loaded, db: Db): any {
  const pool = new L.pg.Pool({ connectionString: db.url, max: 4 });
  later(() => pool.end());
  return pool;
}

/**
 * The adapter as an app would build it: over the app's pool when the adapter shares the app's pg,
 * else (p710-private, a private pg copy) the config form, since the app's pool crashes the adapter there (spike Q1).
 */
export function adapterFor(fx: Fixture, L: Loaded, pool: any, db: Db): any {
  return L.adapterPg === L.pg ? new L.PrismaPg(pool) : new L.PrismaPg({ connectionString: db.url });
}

export async function runWorkload(p: any): Promise<void> {
  for (const w of WORKLOAD) {
    try {
      await w.run(p);
    } catch (e) {
      throw new Error(`workload call ${w.label} failed: ${(e as Error).message}`);
    }
  }
}

export const RAW = [1, 2, 3, 4, 5];
export async function rawQueries(pool: any): Promise<void> {
  for (const n of RAW) await pool.query('SELECT COUNT(*) AS n FROM "Product" WHERE "price" > $1', [n]);
}

export const total = (items: Item[]): number => sum(items.map((i) => i.count));
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Engine spans (5.22/6.0 createEngineSpan, 6.1+ dispatchEngineSpans) can land just after the Prisma call
 * returns. Flush until the counted total reaches `want` (at most `ms`), then settle and flush once more,
 * so a late extra statement still shows up as a double count. The assertion stays exact.
 */
export async function flushUntil(a: { flush(): Promise<void> }, items: () => Item[], want: number, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  await a.flush();
  while (total(items()) < want && Date.now() < end) {
    await sleep(50);
    await a.flush();
  }
  await sleep(250);
  await a.flush();
}
export const sqlItems = (items: Item[]): Item[] => items.filter((i) => i.source === 'postgresql');

/** The one item whose SQL matches. */
export function itemMatching(items: Item[], re: RegExp): Item {
  const found = items.filter((i) => re.test(sqlOf(i)));
  expect(found, `items matching ${re}: ${items.map(sqlOf).join(' | ')}`).toHaveLength(1);
  return found[0]!;
}

/**
 * Records the text of every call reaching `Client.prototype.query` of each class, underneath any
 * SDK wrapper installed later: exactly what pg is asked to send.
 */
export function recordSent(classes: readonly Function[]): { texts: string[] } {
  const texts: string[] = [];
  for (const C of new Set(classes)) {
    const proto = (C as { prototype: { query: (...a: unknown[]) => unknown } }).prototype;
    const had = Object.prototype.hasOwnProperty.call(proto, 'query');
    const orig = proto.query;
    proto.query = function query(this: unknown, config: unknown): unknown {
      const t = typeof config === 'string' ? config : (config as { text?: unknown } | null)?.text;
      if (typeof t === 'string') texts.push(t);
      // eslint-disable-next-line prefer-rest-params
      return Reflect.apply(orig, this, arguments);
    };
    // Runs after shutdown() (cleanups run after it), when the SDK has put this recorder back on top.
    later(() => {
      if (had) proto.query = orig;
      else delete (proto as { query?: unknown }).query;
    });
  }
  return { texts };
}

/** Prisma <= 6.1 emits createMany's column list in a random order per call (spike Q6): compare with it sorted. */
export const canon = (t: string): string =>
  t.replace(/^(INSERT INTO \S+ \()([^)]*)(\) VALUES)/, (_m, a: string, cols: string, b: string) => a + cols.split(',').sort().join(',') + b);

/** Deterministic OTel ids (xorshift32 from a fixed seed), so two runs make the same sampling decisions. */
export function seededIds(): { generateTraceId(): string; generateSpanId(): string } {
  let x = 0x9e3779b9;
  const next = (): string => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0).toString(16).padStart(8, '0');
  };
  return { generateTraceId: () => next() + next() + next() + next(), generateSpanId: () => next() + next() };
}

/**
 * The app's own tracing, as an OTel app sets it up: a BasicTracerProvider (AlwaysOn, or a parent-based
 * ratio sampler) with an in-memory exporter, an AsyncLocalStorage context manager, and
 * `new PrismaInstrumentation()` (enabled on construction), all from the fixture's own packages.
 * `stop()` undoes it (also run after the test).
 */
export function appTracing(L: Loaded, sampler: 'always' | number) {
  const { api, base, ctx } = L.otel;
  const exporter = new base.InMemorySpanExporter();
  const s = sampler === 'always'
    ? new base.AlwaysOnSampler()
    : new base.ParentBasedSampler({ root: new base.TraceIdRatioBasedSampler(sampler) });
  const provider = new base.BasicTracerProvider({ sampler: s, idGenerator: seededIds(), spanProcessors: [new base.SimpleSpanProcessor(exporter)] });
  api.context.setGlobalContextManager(new ctx.AsyncLocalStorageContextManager().enable());
  api.trace.setGlobalTracerProvider(provider);
  const instr = new L.instrumentation.PrismaInstrumentation();
  instr.setTracerProvider?.(provider);
  instr.enable();
  /** Exported spans as `name` plus attribute keys, sorted: comparable across runs (ids and times differ). */
  const read = (): string[] =>
    (exporter.getFinishedSpans() as { name: string; attributes: Record<string, unknown> }[])
      .map((sp) => `${sp.name} ${Object.keys(sp.attributes).sort().join(',')}`)
      .sort();
  let snapshot: string[] | null = null;
  const stop = async (): Promise<void> => {
    if (snapshot !== null) return;
    // The 5.22/6.0 engine hands over its last span events a little after the call returns; let them
    // land on this helper, not on the next test's (another Prisma version's helper lacks createEngineSpan).
    await new Promise((r) => setTimeout(r, 250));
    snapshot = read(); // shutdown() empties the in-memory exporter
    instr.disable();
    api.trace.disable();
    api.context.disable();
    await provider.shutdown();
  };
  later(stop);
  const spans = (): string[] => snapshot ?? read();
  return { stop, spans };
}

/** 5.22/6.0 read the helper only from a client generated with previewFeatures = ["tracing"]. */
export const tracingClient = (fx: Fixture): 'client' | 'tracing' => (fx.hasTracingClient ? 'tracing' : 'client');

export const byName = (name: string): Fixture => FIXTURES.find((f) => f.name === name)!;

/** The library-engine describes (engine path, adapter path with app tracing) for one 5.22/6.0/6.19 fixture. */
export function engineSuite(name: string): void {
  const fx = byName(name);
  if (fx.major >= 7) throw new Error(`engineSuite: ${name} has no library engine`);
  describe.skipIf(!available.ok)(`${fx.name} engine path`, SUITE, () => {
    it('without app tracing: no SQL items, the SQL is unchanged, nothing throws', async () => {
      const db = await dbFor(fx);
      const L = load(fx);
      const { a, items, errors } = start(fx, L);
      const { p, events } = prisma(L, { datasourceUrl: db.url });
      await runWorkload(p);
      await a.flush();
      expect(referenceCount(events)).toBeGreaterThanOrEqual(WORKLOAD.length);
      expect(sqlItems(items())).toEqual([]);
      expect(events.filter((e) => /traceparent/i.test(e.query))).toEqual([]);
      expect(errors).toEqual([]);
    });

    it("with the app's own tracing and an always-on sampler: every statement once, labelled orm prisma", async () => {
      const db = await dbFor(fx);
      const L = load(fx);
      appTracing(L, 'always'); // registered before the client (6.1+ fixes engine tracing at engine creation)
      const { a, items, errors } = start(fx, L);
      const { p, events } = prisma(L, { datasourceUrl: db.url }, tracingClient(fx), fx);
      await runWorkload(p);
      const ref = referenceCount(events);
      await flushUntil(a, items, ref);
      expect(ref).toBeGreaterThanOrEqual(WORKLOAD.length);
      expect(total(items())).toBe(ref);
      for (const i of items()) expect(i).toMatchObject({ source: 'postgresql', orm: 'prisma', errors: 0 });
      expect(errors).toEqual([]);
    });

    it("with a 50% ratio sampler: at most the reference, and the app's exported spans are the same with and without the SDK", async () => {
      const db = await dbFor(fx);
      const L = load(fx);
      const run = async (withSdk: boolean) => {
        const t = appTracing(L, 0.5);
        const sdk = withSdk ? start(fx, L) : null;
        const { p, events } = prisma(L, { datasourceUrl: db.url }, tracingClient(fx), fx);
        await runWorkload(p);
        await p.$disconnect();
        await sleep(250); // late engine spans land before the count is read
        await sdk?.a.flush();
        await t.stop();
        const out = { spans: t.spans(), ref: referenceCount(events), counted: sdk ? total(sdk.items()) : 0 };
        if (sdk) await shutdown();
        return out;
      };
      const without = await run(false);
      const withSdk = await run(true);
      expect(withSdk.spans).toEqual(without.spans);
      expect(withSdk.spans.length).toBeGreaterThan(0);
      // Decision 3: on the engine path the SDK sees only what the app samples.
      expect(withSdk.counted).toBeGreaterThan(0);
      expect(withSdk.counted).toBeLessThanOrEqual(withSdk.ref);
    });
  });

  describe.skipIf(!available.ok)(`${fx.name} adapter path with app tracing`, SUITE, () => {
    it('engine db_query spans with a js:query child are skipped, so pg counts each statement once', async () => {
      const db = await dbFor(fx);
      const L = load(fx);
      appTracing(L, 'always');
      const { a, items, errors } = start(fx, L);
      const pool = appPool(L, db);
      const { p, events } = prisma(L, { adapter: adapterFor(fx, L, pool, db) }, tracingClient(fx), fx);
      await runWorkload(p);
      await flushUntil(a, items, referenceCount(events));
      expect(total(items())).toBe(referenceCount(events));
      // Every item came from pg (which knows the database); none from an engine span.
      for (const i of items()) expect(i).toMatchObject({ database: db.name, orm: 'prisma' });
      expect(errors).toEqual([]);
    });
  });
}
