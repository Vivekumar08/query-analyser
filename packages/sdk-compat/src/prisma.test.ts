import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../../sdk/src/index.js';
import { resolvePgClients } from '../../sdk/src/drivers.js';
import { undoPgWraps } from '../../sdk/src/integrations/pg.js';
import { pgCoversAdapter, undoPrismaHook } from '../../sdk/src/integrations/prisma.js';
import { sqlRuntime } from '../../sdk/src/sql/context.js';
import { capture, itemsOf, sqlOf } from './pg-harness.js';
import { FIXTURES, WORKLOAD, load, referenceCount, resolverAt, type Loaded } from './prisma-harness.js';
import {
  SUITE, adapterFor, appPool, available, byName, canon, dbFor, itemMatching, later, prisma, rawQueries, RAW,
  recordSent, registerPrismaHooks, runWorkload, sqlItems, start, total, type Item,
} from './prisma-suite.js';

/**
 * Prisma compat (Task 19), the adapter-path half: every fixture's adapter path, the p710-private Review
 * Focus, a Prisma 7 app helper with isEnabled() false, and Prisma 7 + Accelerate offline. The library-engine
 * paths are in prisma-engine-<name>.test.ts (one worker per engine). Shared plumbing: prisma-suite.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

registerPrismaHooks();

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
}, SUITE);

describe.skipIf(!available.ok)('p710-private', SUITE, () => {
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

describe.skipIf(!available.ok)("p710 with the app's helper reporting isEnabled() false", SUITE, () => {
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
 * whenever the helper's isEnabled() is true. The SDK's own helper always reports false (fix round 1), so
 * the SDK must not add either header; the plan bodies and the app's query log events are unchanged too.
 */
describe('p710 with Accelerate (offline: a stubbed fetch, no network)', SUITE, () => {
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

  it("with the SDK: still no traceparent and no tracing capture; the request body and the app's query events are unchanged", async () => {
    const L = load(fx);
    const without = await run(L);
    const { a } = start(fx, L);
    const withSdk = await run(L);
    await a.flush();
    expect(withSdk.sent.map((s) => s.path)).toEqual(without.sent.map((s) => s.path));
    for (const s of withSdk.sent) {
      expect(s.traceparent).toBeUndefined(); // the SDK's helper reports isEnabled() false (fix round 1 ruling)
      expect(s.capture ?? '').not.toMatch(/tracing/);
    }
    expect(withSdk.sent.map((s) => s.capture)).toEqual(without.sent.map((s) => s.capture));
    expect(withSdk.sent.map((s) => s.body)).toEqual(without.sent.map((s) => s.body)); // the plan (and its SQL) is unchanged
    expect(withSdk.result).toEqual(without.result);
    expect(withSdk.queries).toEqual(without.queries); // log events are still emitted (own helper forwards them)
  });
});

