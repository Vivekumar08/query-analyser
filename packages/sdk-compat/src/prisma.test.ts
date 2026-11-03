import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { init, shutdown } from '../../sdk/src/index.js';
import { resolvePgClients } from '../../sdk/src/drivers.js';
import { installPgPoolWrap, installPgWrap, undoPgWraps } from '../../sdk/src/integrations/pg.js';
import { pgCoversAdapter, undoPrismaHook } from '../../sdk/src/integrations/prisma.js';
import { sqlRuntime } from '../../sdk/src/sql/context.js';
import { createThrowawayDb, pgAvailable } from '../../sdk/src/__tests__/pg-db.js';
import { capture, itemsOf, sqlOf, sum, type PgItem } from './pg-harness.js';
import { FIXTURES, WORKLOAD, load, pushSchema, referenceCount, resolverAt, type Fixture, type Loaded } from './prisma-harness.js';

/**
 * Prisma 5.22, 6.0, 6.19 and 7.10 against a real Postgres (Task 19). Each fixture is its own npm
 * project (`pnpm --filter @query-analyser/sdk-compat prisma:setup`) and gets its own throwaway
 * database, schema pushed with its own CLI, dropped in afterAll.
 *
 * Wiring, as init() does it for a resolved copy: init({ pg: fx.pg }), then resolvePgClients from the
 * fixture's own location (the aliased fixture copies are not what init() resolves from the SDK),
 * each class wrapped, and the runtime's adapter flags set from that result.
 *
 * The reference count is Prisma's own `$on('query')` (log level `query`, emitted as events); the
 * tests read only `e.query`, never `params`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const available = await pgAvailable();
if (!available.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[prisma compat] skipped: no reachable Postgres (${available.reason}). Set QA_PG_URL or apps/api/.env DATABASE_URL.`);
}

type Db = Awaited<ReturnType<typeof createThrowawayDb>>;
type Item = PgItem & { orm?: string };

const SETUP_HINT = 'run pnpm --filter @query-analyser/sdk-compat prisma:setup';
const dbs = new Map<string, Promise<Db>>();

/** The fixture's throwaway database with its schema pushed (created once per fixture). */
function dbFor(fx: Fixture): Promise<Db> {
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
const cleanups: (() => unknown)[] = [];
const later = (fn: () => unknown): void => { cleanups.push(fn); };

async function cleanup(): Promise<void> {
  await shutdown();
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
}

beforeAll(() => {
  if (!available.ok) return;
  const missing = FIXTURES.filter((fx) => !existsSync(join(fx.dir, 'generated', 'client')));
  if (missing.length > 0) throw new Error(`prisma fixtures not set up (${missing.map((f) => f.name).join(', ')}): ${SETUP_HINT}`);
});

afterEach(cleanup, 60_000);

afterAll(async () => {
  await cleanup();
  for (const p of dbs.values()) {
    const db = await p.catch(() => null);
    await db?.drop();
  }
}, 120_000);

/** init() plus the fixture-rooted pg wiring. Returns the analyser, its captured bodies and onError reports. */
function start(fx: Fixture, L: Loaded) {
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
function prisma(L: Loaded, opts: Record<string, unknown>, which: 'client' | 'tracing' = 'client', fx?: Fixture) {
  const Ctor = which === 'client' ? L.PrismaClient : load(fx!, 'tracing').PrismaClient;
  const p = new Ctor({ ...opts, log: [{ emit: 'event', level: 'query' }] });
  const events: { query: string }[] = [];
  p.$on('query', (e: { query: string }) => { events.push({ query: e.query }); });
  later(() => p.$disconnect());
  return { p, events };
}

/** An app pool on the fixture's own pg. */
function appPool(L: Loaded, db: Db): any {
  const pool = new L.pg.Pool({ connectionString: db.url, max: 4 });
  later(() => pool.end());
  return pool;
}

/**
 * The adapter as an app would build it: over the app's pool when the adapter shares the app's pg,
 * else (p710-private, a private pg copy) the config form, since the app's pool crashes the adapter there (spike Q1).
 */
function adapterFor(fx: Fixture, L: Loaded, pool: any, db: Db): any {
  return L.adapterPg === L.pg ? new L.PrismaPg(pool) : new L.PrismaPg({ connectionString: db.url });
}

async function runWorkload(p: any): Promise<void> {
  for (const w of WORKLOAD) {
    try {
      await w.run(p);
    } catch (e) {
      throw new Error(`workload call ${w.label} failed: ${(e as Error).message}`);
    }
  }
}

const RAW = [1, 2, 3, 4, 5];
async function rawQueries(pool: any): Promise<void> {
  for (const n of RAW) await pool.query('SELECT COUNT(*) AS n FROM "Product" WHERE "price" > $1', [n]);
}

const total = (items: Item[]): number => sum(items.map((i) => i.count));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Engine spans (5.22/6.0 createEngineSpan, 6.1+ dispatchEngineSpans) can land just after the Prisma call
 * returns. Flush until the counted total reaches `want` (at most `ms`), then settle and flush once more,
 * so a late extra statement still shows up as a double count. The assertion stays exact.
 */
async function flushUntil(a: { flush(): Promise<void> }, items: () => Item[], want: number, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  await a.flush();
  while (total(items()) < want && Date.now() < end) {
    await sleep(50);
    await a.flush();
  }
  await sleep(250);
  await a.flush();
}
const sqlItems = (items: Item[]): Item[] => items.filter((i) => i.source === 'postgresql');

/** The one item whose SQL matches. */
function itemMatching(items: Item[], re: RegExp): Item {
  const found = items.filter((i) => re.test(sqlOf(i)));
  expect(found, `items matching ${re}: ${items.map(sqlOf).join(' | ')}`).toHaveLength(1);
  return found[0]!;
}

/**
 * Records the text of every call reaching `Client.prototype.query` of each class, underneath any
 * SDK wrapper installed later: exactly what pg is asked to send.
 */
function recordSent(classes: readonly Function[]): { texts: string[] } {
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
const canon = (t: string): string =>
  t.replace(/^(INSERT INTO \S+ \()([^)]*)(\) VALUES)/, (_m, a: string, cols: string, b: string) => a + cols.split(',').sort().join(',') + b);

describe.skipIf(!available.ok).each(FIXTURES)('$name adapter path', (fx) => {
  it(`loads Prisma ${fx.prisma} with the app's pg ${fx.pg}`, () => {
    const L = load(fx);
    const at = resolverAt(fx.dir);
    const version = (name: string): string =>
      (JSON.parse(readFileSync(join(fx.dir, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
    expect(version('@prisma/client')).toBe(fx.prisma);
    expect(version('@prisma/adapter-pg')).toBe(fx.prisma);
    expect(version('pg')).toBe(fx.pg);
    expect(at('pg')).not.toBeNull();
    expect(L.adapterPg === L.pg).toBe(fx.name !== 'p710-private');
  });

  it('exactly once: N Prisma calls and M raw pg queries on the shared pool equal the reference count', async () => {
    const db = await dbFor(fx);
    const L = load(fx);
    const { a, items, errors } = start(fx, L);
    const pool = appPool(L, db);
    const { p, events } = prisma(L, { adapter: adapterFor(fx, L, pool, db) });
    await runWorkload(p);
    await rawQueries(pool);
    await a.flush();
    const ref = referenceCount(events);
    expect(ref).toBeGreaterThanOrEqual(WORKLOAD.length);
    expect(total(items())).toBe(ref + RAW.length);
    for (const i of items()) expect(i).toMatchObject({ source: 'postgresql', database: db.name, errors: 0 });
    expect(errors).toEqual([]);
  });

  it('labels: Prisma 7 statements carry model and operation; 5/6 carry orm prisma with the table as model', async () => {
    const db = await dbFor(fx);
    const L = load(fx);
    const pool = appPool(L, db);
    const { p } = prisma(L, { adapter: adapterFor(fx, L, pool, db) });
    const email = `label_${Date.now().toString(36)}@x.test`;
    await p.user.create({ data: { email, name: 'l' } }); // before init(): not captured
    const { a, items } = start(fx, L);
    await p.user.findUnique({ where: { email } });
    await p.$transaction([p.user.count(), p.product.count()]);
    await a.flush();

    const all = items();
    const find = itemMatching(all, /"email" = \?/);
    const counts = all.filter((i) => /count\(\*\)/i.test(sqlOf(i)));
    expect(counts, all.map(sqlOf).join(' | ')).toHaveLength(2);
    if (fx.major === 7) {
      expect(find).toMatchObject({ orm: 'prisma', model: 'User', operation: 'findUnique' });
      // $transaction([user.count, product.count]): both statements carry the first operation's label (documented).
      for (const c of counts) expect(c).toMatchObject({ orm: 'prisma', model: 'User', operation: 'count' });
    } else {
      // Decision 5: no per-operation context on 5/6; the adapter's call shape gives orm prisma, the SQL the rest.
      expect(find).toMatchObject({ orm: 'prisma', model: 'User', operation: 'select' });
      for (const c of counts) expect(c).toMatchObject({ orm: 'prisma', operation: 'select' });
    }
  });

  it('the SQL sent is unchanged: no pg-captured text contains traceparent, and texts equal a run without the SDK', async () => {
    const db = await dbFor(fx);
    const L = load(fx);
    const r = resolvePgClients(L.pg, { appEntry: resolverAt(fx.dir) });
    const sent = recordSent(r.clients);
    const pool = appPool(L, db);
    const { p } = prisma(L, { adapter: adapterFor(fx, L, pool, db) });

    await runWorkload(p); // without the SDK
    const without = sent.texts.splice(0);
    const { a, items } = start(fx, L);
    await runWorkload(p);
    await a.flush();
    const withSdk = sent.texts.splice(0);

    expect(total(items())).toBeGreaterThan(0); // the SDK was on
    expect(withSdk.filter((t) => /traceparent/i.test(t))).toEqual([]);
    expect(withSdk.map(canon)).toEqual(without.map(canon));
  });

  it('two SDK copies loaded at once still count each statement once', async () => {
    const db = await dbFor(fx);
    const L = load(fx);
    const first = start(fx, L);
    vi.resetModules();
    const copy = await import('../../sdk/src/index.js');
    const copyPg = await import('../../sdk/src/integrations/pg.js');
    expect(copy.init).not.toBe(init); // a second module instance of the SDK
    const capB = capture();
    const b = copy.init({ apiKey: 'k', app: `compat-${fx.name}-b`, thresholdMs: 0, fetchImpl: capB.fetchImpl, pg: L.pg });
    later(async () => {
      await b.shutdown();
      // The first copy's wraps stay while the second copy's sink is the live one; take them off here.
      undoPgWraps();
      undoPrismaHook();
    });
    for (const C of first.r.clients) expect(copyPg.installPgWrap(C)).toBe(false); // never stacks

    const pool = appPool(L, db);
    const { p, events } = prisma(L, { adapter: adapterFor(fx, L, pool, db) });
    await runWorkload(p);
    await rawQueries(pool);
    await first.a.flush();
    await b.flush();
    const both = [...first.items(), ...(itemsOf(capB.bodies) as Item[])];
    expect(total(both)).toBe(referenceCount(events) + RAW.length);
  });
});

/** Deterministic OTel ids (xorshift32 from a fixed seed), so two runs make the same sampling decisions. */
function seededIds(): { generateTraceId(): string; generateSpanId(): string } {
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
function appTracing(L: Loaded, sampler: 'always' | number) {
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

const ENGINE = FIXTURES.filter((f) => f.major < 7);
/** 5.22/6.0 read the helper only from a client generated with previewFeatures = ["tracing"]. */
const tracingClient = (fx: Fixture): 'client' | 'tracing' => (fx.hasTracingClient ? 'tracing' : 'client');

describe.skipIf(!available.ok).each(ENGINE)('$name engine path', (fx) => {
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

describe.skipIf(!available.ok).each(ENGINE)('$name adapter path with app tracing', (fx) => {
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

const byName = (name: string): Fixture => FIXTURES.find((f) => f.name === name)!;

describe.skipIf(!available.ok)('p710-private', () => {
  it("Review Focus: the adapter's private pg copy is found and every statement counted once", async () => {
    const fx = byName('p710-private');
    const db = await dbFor(fx);
    const L = load(fx);
    expect(L.adapterPg).not.toBe(L.pg); // app pg 8.11.6, adapter's own 8.23.x
    const { a, items, r, errors } = start(fx, L);
    expect(r.clients).toHaveLength(2);
    expect(new Set(r.clients)).toEqual(new Set([L.pg.Client, L.adapterPg.Client]));
    expect(sqlRuntime().pgCoversPrismaAdapter).toBe(true);
    const { p, events } = prisma(L, { adapter: new L.PrismaPg({ connectionString: db.url }) }); // config form
    await runWorkload(p);
    await a.flush();
    expect(total(items())).toBe(referenceCount(events));
    expect(itemMatching(items(), /"email" = \? AND/)).toMatchObject({ orm: 'prisma', model: 'User', operation: 'findUnique' });
    expect(errors).toEqual([]);
  });
});

/** An app's own Prisma 7 tracing helper that is switched off (isEnabled() false), installed before init(). */
function disabledAppHelper(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.V7_PRISMA_INSTRUMENTATION = {
    helper: {
      isEnabled: () => false,
      getTraceParent: () => '00-10-10-00',
      dispatchEngineSpans: () => undefined,
      getActiveContext: () => undefined,
      runInChildSpan: (_o: unknown, cb: () => unknown) => cb(),
    },
  };
  later(() => { delete g.V7_PRISMA_INSTRUMENTATION; }); // after shutdown() put the app's value back
}

describe.skipIf(!available.ok)("p710 with the app's helper reporting isEnabled() false", () => {
  const fx = byName('p710');

  it('pg covers the adapter: every statement once, from pg, labelled from the operation frame', async () => {
    const db = await dbFor(fx);
    const L = load(fx);
    disabledAppHelper();
    const { a, items, errors } = start(fx, L);
    const pool = appPool(L, db);
    const { p, events } = prisma(L, { adapter: adapterFor(fx, L, pool, db) });
    await runWorkload(p);
    await a.flush();
    expect(total(items())).toBe(referenceCount(events));
    // No db_query spans (Prisma skips them when the helper is disabled), but `operation` spans still run
    // through the wrapped helper, so pg's statements carry the operation's labels.
    expect(itemMatching(items(), /"email" = \? AND/)).toMatchObject({ orm: 'prisma', model: 'User', operation: 'findUnique' });
    expect(errors).toEqual([]);
  });

  it('pg does not cover the adapter: no statements recorded, no double count, nothing throws', async () => {
    const db = await dbFor(fx);
    const L = load(fx);
    disabledAppHelper();
    const cap = capture();
    const errors: Error[] = [];
    // init() alone: the fixture's pg is not a copy init() resolves, so nothing wraps the adapter's pg.
    const a = init({ apiKey: 'k', app: 'compat-p710-off', thresholdMs: 0, fetchImpl: cap.fetchImpl, onError: (e) => { errors.push(e); } });
    sqlRuntime().prismaAdapterResolved = true;
    expect(pgCoversAdapter(true, L.adapterPg)).toBe(false);
    const pool = appPool(L, db);
    const { p, events } = prisma(L, { adapter: adapterFor(fx, L, pool, db) });
    await runWorkload(p);
    await a.flush();
    expect(referenceCount(events)).toBeGreaterThanOrEqual(WORKLOAD.length);
    expect(sqlItems(itemsOf(cap.bodies) as Item[])).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/**
 * Prisma 7 + Accelerate, offline (Task 7 carry): globalThis.fetch is replaced by a stub that answers like
 * a data proxy, so no request leaves the process. RemoteExecutor reads `globalThis.fetch` per request
 * (RemoteExecutor.ts #request), and HeaderBuilder.ts adds `traceparent` and `X-Capture-Telemetry: tracing`
 * whenever the helper's isEnabled() is true.
 */
describe("p710 with Accelerate (offline: a stubbed fetch, no network)", () => {
  const fx = byName('p710');
  type Sent = { path: string; traceparent?: string; capture?: string; body: string | null };

  async function run(L: Loaded) {
    const sent: Sent[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, req?: RequestInit) => {
      const u = new URL(String(url));
      const h = (req?.headers ?? {}) as Record<string, string>;
      sent.push({ path: u.pathname, traceparent: h.traceparent, capture: h['X-Capture-Telemetry'], body: typeof req?.body === 'string' ? req.body : null });
      if (u.pathname === '/connection-info') {
        return new Response(JSON.stringify({ provider: 'postgres', connectionInfo: { schemaName: 'public', supportsRelationJoins: true } }), { status: 200 });
      }
      // A result with engine spans and one query log event, as a data proxy returns when it captures telemetry.
      const extensions = {
        spans: [{ id: '1', parentId: null, name: 'prisma:engine:db_query', startTime: [0, 0], endTime: [0, 1000], kind: 'client', attributes: {} }],
        logs: [{ level: 'query', timestamp: [0, 0], attributes: { query: 'SELECT 1', duration_ms: 1, params: '[]' } }],
      };
      return new Response(JSON.stringify({ data: 1, extensions }), { status: 200 });
    }) as typeof fetch;
    try {
      const p = new L.PrismaClient({ accelerateUrl: 'prisma://accelerate.invalid/?api_key=offline-test', log: [{ emit: 'event', level: 'query' }] });
      const queries: string[] = [];
      p.$on('query', (e: { query: string }) => { queries.push(e.query); });
      const result: unknown = await p.$executeRaw`SELECT 1`;
      await p.$disconnect();
      return { sent, queries, result };
    } finally {
      globalThis.fetch = real;
    }
  }

  it('without the SDK: no traceparent header and no tracing capture', async () => {
    const out = await run(load(fx));
    expect(out.sent.map((s) => s.path)).toEqual(['/connection-info', '/query']);
    for (const s of out.sent) {
      expect(s.traceparent).toBeUndefined();
      expect(s.capture ?? '').not.toMatch(/tracing/);
    }
    expect(out.queries).toEqual(['SELECT 1']);
  });

  it("with the SDK: an unsampled traceparent and a tracing capture header; the request body and the app's query events are unchanged", async () => {
    const L = load(fx);
    const without = await run(L);
    const { a } = start(fx, L);
    const withSdk = await run(L);
    await a.flush();
    for (const s of withSdk.sent) {
      expect(s.traceparent).toBe('00-10-10-00'); // the SDK's DISABLED_TRACEPARENT: unsampled, never a real trace
      expect(s.capture).toMatch(/^tracing\b/);
    }
    expect(withSdk.sent.map((s) => s.body)).toEqual(without.sent.map((s) => s.body)); // the plan (and its SQL) is unchanged
    expect(withSdk.result).toEqual(without.result);
    expect(withSdk.queries).toEqual(without.queries); // log events are still emitted (own helper forwards them)
  });
});
