import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sqlRuntime, type SqlFrame, type StatementFrame } from '../sql/context.js';
import type { StatementEvent } from '../sql/core.js';
import { PG_QUERY_WRAP } from './pg.js';
import {
  installPrismaHook, ensurePrismaHook, undoPrismaHook, appHelperPresent, createOwnHelper, wrapAppHelper,
  statementsFromBatch, createLegacySpanTracker, pgCoversAdapter,
  PRISMA_HOOK, OWN_HELPER_KEY, WATCHED_KEYS, DISABLED_TRACEPARENT,
} from './prisma.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as Record<string, any>;
const rt = sqlRuntime();
let rec: { events: StatementEvent[]; record(ev: StatementEvent): void };

/**
 * A fake of the app's `@prisma/instrumentation` ActiveTracingHelper, in the shapes the spike
 * recorded: `runInChildSpan(nameOrOptions, cb)` calls `cb(span, context)`; `dispatchEngineSpans`
 * (6.1+) and `createEngineSpan` (5.22/6.0) receive engine spans; `getTraceParent` is sampled.
 */
function appHelper() {
  const span = { span: 'otel' };
  const ctx = { ctx: 'otel' };
  return {
    isEnabled: vi.fn(() => true),
    getTraceParent: vi.fn(() => '00-aa-bb-01'),
    getActiveContext: vi.fn(() => ctx),
    runInChildSpan: vi.fn((_o: unknown, cb: (s: unknown, c: unknown) => unknown) => cb(span, ctx)),
    dispatchEngineSpans: vi.fn(),
    createEngineSpan: vi.fn(),
    span, ctx,
  };
}

const opSpan = (method: string, model?: string) => ({ name: 'operation', attributes: model ? { method, model, name: `${model}.${method}` } : { method, name: method } });
const dbSpan = (text: string) => ({ name: 'db_query', kind: 2, attributes: { 'db.query.text': text, 'db.system.name': 'postgresql' } });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

beforeEach(() => {
  rec = { events: [], record(ev) { this.events.push(ev); } };
  rt.pgCoversPrismaAdapter = false;
});
afterEach(() => {
  undoPrismaHook();
  for (const k of WATCHED_KEYS) delete g[k];
  rt.sink = null;
  rt.pgCoversPrismaAdapter = false;
});

describe('accessors', () => {
  it('installs its own helper on the V7 key only', () => {
    expect(installPrismaHook()).toBe(true); rt.sink = rec;
    expect(g.V7_PRISMA_INSTRUMENTATION.helper.isEnabled()).toBe(true);
    expect(g.V6_PRISMA_INSTRUMENTATION).toBeUndefined(); expect(g.PRISMA_INSTRUMENTATION).toBeUndefined();
    expect(OWN_HELPER_KEY).toBe('V7_PRISMA_INSTRUMENTATION');
    expect(WATCHED_KEYS).toEqual(['V7_PRISMA_INSTRUMENTATION', 'V6_PRISMA_INSTRUMENTATION', 'PRISMA_INSTRUMENTATION']);
    expect(PRISMA_HOOK).toBe(Symbol.for('query-analyser.prisma-hook'));
    expect(typeof (g as any)[PRISMA_HOOK].owner).toBe('object');
  });

  it('does nothing while there is no sink: the app value unchanged, or undefined', () => {
    const holder = { helper: appHelper() };
    g.V6_PRISMA_INSTRUMENTATION = holder;
    installPrismaHook();
    expect(g.V7_PRISMA_INSTRUMENTATION).toBeUndefined();
    expect(g.V6_PRISMA_INSTRUMENTATION).toBe(holder);
    rt.sink = rec;
    expect(g.V6_PRISMA_INSTRUMENTATION).not.toBe(holder);
  });

  it('wraps an app helper assigned after install (SDK first), delegates every call and keeps its traceparent', () => {
    installPrismaHook(); rt.sink = rec;
    const app = { isEnabled: () => true, getTraceParent: () => '00-aa-bb-01', runInChildSpan: vi.fn((o: unknown, cb: () => unknown) => cb()), dispatchEngineSpans: vi.fn(), extra: 42 };
    g.V6_PRISMA_INSTRUMENTATION = { helper: app };
    const seen = g.V6_PRISMA_INSTRUMENTATION.helper;
    expect(seen).not.toBe(app);
    expect(seen.getTraceParent()).toBe('00-aa-bb-01'); expect(seen.extra).toBe(42);
    expect(seen.runInChildSpan({ name: 'operation', attributes: { method: 'm' } }, () => 1)).toBe(1);
    expect(app.runInChildSpan).toHaveBeenCalledOnce();
    seen.dispatchEngineSpans([]); expect(app.dispatchEngineSpans).toHaveBeenCalledWith([]);
  });

  it("a helper already present at install time (app first) is treated as the app's", () => {
    const app = appHelper();
    const holder = { helper: app, other: 'kept' };
    g.PRISMA_INSTRUMENTATION = holder;
    expect(appHelperPresent()).toBe(true);
    installPrismaHook(); rt.sink = rec;
    expect(appHelperPresent()).toBe(true);
    const seen = g.PRISMA_INSTRUMENTATION;
    expect(seen.other).toBe('kept');
    expect(seen.helper).not.toBe(app);
    expect(seen.helper.getTraceParent()).toBe('00-aa-bb-01');
    expect(g.PRISMA_INSTRUMENTATION.helper).toBe(seen.helper); // cached per stored object
  });

  it('an app helper on the V7 key replaces the own helper, in both registration orders', () => {
    const a = appHelper();
    g.V7_PRISMA_INSTRUMENTATION = { helper: a };
    installPrismaHook(); rt.sink = rec;
    expect(g.V7_PRISMA_INSTRUMENTATION.helper.getTraceParent()).toBe('00-aa-bb-01');
    undoPrismaHook(); delete g.V7_PRISMA_INSTRUMENTATION;

    installPrismaHook();
    expect(g.V7_PRISMA_INSTRUMENTATION.helper.getTraceParent()).toBe(DISABLED_TRACEPARENT);
    expect(appHelperPresent()).toBe(false);
    const b = appHelper();
    g.V7_PRISMA_INSTRUMENTATION = { helper: b };
    expect(appHelperPresent()).toBe(true);
    expect(g.V7_PRISMA_INSTRUMENTATION.helper.getTraceParent()).toBe('00-aa-bb-01');
  });

  it("detects an app's later assignment and re-wraps the new helper", () => {
    installPrismaHook(); rt.sink = rec;
    const first = appHelper(); const second = appHelper();
    g.V6_PRISMA_INSTRUMENTATION = { helper: first };
    g.V6_PRISMA_INSTRUMENTATION.helper.runInChildSpan(opSpan('findMany', 'User'), () => 1);
    g.V6_PRISMA_INSTRUMENTATION = { helper: second };
    g.V6_PRISMA_INSTRUMENTATION.helper.runInChildSpan(opSpan('count', 'Post'), () => 1);
    expect(first.runInChildSpan).toHaveBeenCalledTimes(1);
    expect(second.runInChildSpan).toHaveBeenCalledTimes(1);
  });

  it('the setter stores the assigned value; an app clearing it with undefined brings back the own helper on V7', () => {
    installPrismaHook(); rt.sink = rec;
    g.V7_PRISMA_INSTRUMENTATION = { helper: appHelper() };
    g.V7_PRISMA_INSTRUMENTATION = undefined;
    expect(g.V7_PRISMA_INSTRUMENTATION.helper.getTraceParent()).toBe(DISABLED_TRACEPARENT);
    expect(appHelperPresent()).toBe(false);
  });

  it('ensurePrismaHook re-defines an accessor the app deleted', () => {
    installPrismaHook(); rt.sink = rec;
    g.V7_PRISMA_INSTRUMENTATION = { helper: appHelper() };
    delete g.V7_PRISMA_INSTRUMENTATION; // @prisma/instrumentation's clearGlobalTracingHelper
    expect(g.V7_PRISMA_INSTRUMENTATION).toBeUndefined();
    ensurePrismaHook();
    expect(g.V7_PRISMA_INSTRUMENTATION.helper.getTraceParent()).toBe(DISABLED_TRACEPARENT);
    expect(appHelperPresent()).toBe(false);
  });

  it('ensurePrismaHook adopts a value the app assigned after deleting the key, and wraps it', () => {
    installPrismaHook(); rt.sink = rec;
    delete g.V6_PRISMA_INSTRUMENTATION;
    const app = appHelper();
    g.V6_PRISMA_INSTRUMENTATION = { helper: app }; // a plain data property now
    ensurePrismaHook();
    expect(Object.getOwnPropertyDescriptor(globalThis, 'V6_PRISMA_INSTRUMENTATION')?.get).toBeTypeOf('function');
    const seen = g.V6_PRISMA_INSTRUMENTATION.helper;
    expect(seen).not.toBe(app);
    seen.runInChildSpan(opSpan('m'), () => 1);
    expect(app.runInChildSpan).toHaveBeenCalledOnce();
  });

  it('undo restores the app helper as a plain data property, and deletes keys with no app value', () => {
    installPrismaHook(); rt.sink = rec;
    const holder = { helper: appHelper() };
    g.V6_PRISMA_INSTRUMENTATION = holder;
    undoPrismaHook();
    const d = Object.getOwnPropertyDescriptor(globalThis, 'V6_PRISMA_INSTRUMENTATION')!;
    expect(d.value).toBe(holder); expect(d.get).toBeUndefined(); expect(d.writable).toBe(true); expect(d.configurable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(globalThis, 'V7_PRISMA_INSTRUMENTATION')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(globalThis, 'PRISMA_INSTRUMENTATION')).toBeUndefined();
    expect((g as any)[PRISMA_HOOK]).toBeUndefined();
  });

  it('a second copy does not stack', () => {
    expect(installPrismaHook()).toBe(true);
    const getter = Object.getOwnPropertyDescriptor(globalThis, OWN_HELPER_KEY)!.get;
    expect(installPrismaHook()).toBe(false);
    expect(Object.getOwnPropertyDescriptor(globalThis, OWN_HELPER_KEY)!.get).toBe(getter);
  });

  it('a copy that does not own the hook leaves it alone on ensure and undo', () => {
    (g as any)[PRISMA_HOOK] = { owner: {}, stored: new Map() };
    try {
      expect(installPrismaHook()).toBe(false);
      ensurePrismaHook(); undoPrismaHook();
      expect(Object.getOwnPropertyDescriptor(globalThis, OWN_HELPER_KEY)).toBeUndefined();
      expect((g as any)[PRISMA_HOOK]).toBeDefined();
    } finally {
      delete (g as any)[PRISMA_HOOK];
    }
  });
});

describe('own helper', () => {
  beforeEach(() => { rt.sink = rec; });

  it('never hands out a sampled traceparent and has the no-op shape', () => {
    const h = createOwnHelper() as any;
    expect(h.getTraceParent()).toBe('00-10-10-00');
    expect(DISABLED_TRACEPARENT).toBe('00-10-10-00');
    expect(h.isEnabled()).toBe(true);
    expect(h.dispatchEngineSpans([{ name: 'x' }])).toBeUndefined();
    expect(h.getActiveContext()).toBeUndefined();
  });

  it('operation then db_query: an unclaimed statement is recorded with the operation labels and its own timing', async () => {
    const h = createOwnHelper() as any;
    await h.runInChildSpan(opSpan('findMany', 'User'), () =>
      h.runInChildSpan(dbSpan('SELECT 1'), async () => 'rows'));
    expect(rec.events).toEqual([expect.objectContaining({ text: 'SELECT 1', labels: { orm: 'prisma', model: 'User', operation: 'findMany' } })]);
    const ev = rec.events[0]!;
    expect(ev).toEqual({ text: 'SELECT 1', database: null, durationMs: expect.any(Number), failed: false, errorCode: null, labels: ev.labels });
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs callbacks in the frames: operation, then a statement frame whose op is the operation', () => {
    const h = createOwnHelper() as any;
    let opFrame: SqlFrame | undefined; let stFrame: SqlFrame | undefined;
    h.runInChildSpan(opSpan('queryRaw'), () => {
      opFrame = rt.als.getStore();
      h.runInChildSpan(dbSpan('SELECT 2'), () => { stFrame = rt.als.getStore(); });
    });
    expect(opFrame).toEqual({ kind: 'operation', model: null, operation: 'queryRaw' });
    expect(stFrame).toEqual({ kind: 'statement', op: opFrame, claimed: false });
    expect(rt.als.getStore()).toBeUndefined();
  });

  it('a db_query with no enclosing operation is a Prisma statement with no model', () => {
    const h = createOwnHelper() as any;
    h.runInChildSpan('db_query', () => 1); // a string name: no attributes, so no text
    h.runInChildSpan(dbSpan('SELECT 3'), () => 1);
    expect(rec.events.map((e) => [e.text, e.labels])).toEqual([['SELECT 3', { orm: 'prisma', model: null, operation: null }]]);
  });

  it('a db_query claimed by pg underneath is not recorded twice', async () => {
    const h = createOwnHelper() as any;
    await h.runInChildSpan(opSpan('findMany', 'User'), () =>
      h.runInChildSpan(dbSpan('SELECT 1'), async () => { (rt.als.getStore() as StatementFrame).claimed = true; return 'rows'; }));
    expect(rec.events).toEqual([]);
  });

  it('records no db_query at all when the pg wrap covers the adapter (Task 5 ruling), but still sets frames', async () => {
    rt.pgCoversPrismaAdapter = true;
    const h = createOwnHelper() as any;
    let seen: SqlFrame | undefined;
    await h.runInChildSpan(opSpan('findMany', 'User'), () =>
      h.runInChildSpan(dbSpan('SELECT 1'), async () => { seen = rt.als.getStore(); return 'rows'; }));
    expect(rec.events).toEqual([]);
    expect(seen).toMatchObject({ kind: 'statement', op: { model: 'User', operation: 'findMany' } });
  });

  it('records nothing without a sink', async () => {
    rt.sink = null;
    const h = createOwnHelper() as any;
    await h.runInChildSpan(dbSpan('SELECT 1'), async () => 1);
    expect(rec.events).toEqual([]);
  });

  it('returns exactly what the callback returns or throws', async () => {
    const h = createOwnHelper() as any;
    const value = { v: 1 };
    expect(await h.runInChildSpan(dbSpan('SELECT 1'), async () => value)).toBe(value);
    expect(h.runInChildSpan(dbSpan('SELECT 1'), () => value)).toBe(value);
    expect(h.runInChildSpan('serialize', () => value)).toBe(value);
    expect(h.runInChildSpan(opSpan('m', 'M'), () => value)).toBe(value);

    const err = Object.assign(new Error('boom'), { code: '23505' });
    await expect(h.runInChildSpan(dbSpan('INSERT 1'), async () => { throw err; })).rejects.toBe(err);
    expect(() => h.runInChildSpan(dbSpan('INSERT 2'), () => { throw err; })).toThrow(err);
    expect(() => h.runInChildSpan(opSpan('m'), () => { throw err; })).toThrow(err);
    const failed = rec.events.filter((e) => e.failed);
    expect(failed.map((e) => [e.text, e.errorCode])).toEqual([['INSERT 1', '23505'], ['INSERT 2', '23505']]);
  });

  it('passes a non-db thenable through untouched and keeps a db_query thenable on the app path', async () => {
    const h = createOwnHelper() as any;
    const p = Promise.resolve(5);
    expect(h.runInChildSpan(opSpan('m'), () => p)).toBe(p);
    const q = h.runInChildSpan(dbSpan('SELECT 1'), () => p);
    expect(q).not.toBe(p);
    expect(await q).toBe(5);
    const odd = { then() { throw new Error('odd'); } };
    expect(h.runInChildSpan(dbSpan('SELECT 1'), () => odd)).toBe(odd);
  });

  it('never throws from malformed span options', () => {
    const h = createOwnHelper() as any;
    const evil = { get name(): string { throw new Error('evil'); } };
    expect(h.runInChildSpan(evil, () => 7)).toBe(7);
    expect(h.runInChildSpan(null, () => 8)).toBe(8);
    expect(h.runInChildSpan({ name: 'operation', attributes: null }, () => 9)).toBe(9);
    expect(h.runInChildSpan({ name: 'db_query', attributes: { 'db.query.text': 42 } }, () => 10)).toBe(10);
    expect(rec.events).toEqual([]);
  });
});

describe('wrapAppHelper', () => {
  beforeEach(() => { rt.sink = rec; });

  it("frames the app's spans, hands the app's callback the app's own arguments, and returns the app's result", async () => {
    const app = appHelper();
    const w = wrapAppHelper(app) as any;
    let frame: SqlFrame | undefined; let args: unknown[] = [];
    const r = await w.runInChildSpan(opSpan('create', 'User'), (...a: unknown[]) =>
      w.runInChildSpan(dbSpan('INSERT 1'), async (...b: unknown[]) => { frame = rt.als.getStore(); args = [...a, ...b]; return 'ok'; }));
    expect(r).toBe('ok');
    expect(app.runInChildSpan).toHaveBeenCalledTimes(2);
    expect(app.runInChildSpan.mock.calls[0]![0]).toEqual(opSpan('create', 'User')); // options passed unchanged
    expect(args).toEqual([app.span, app.ctx, app.span, app.ctx]);
    expect(frame).toMatchObject({ kind: 'statement', op: { model: 'User', operation: 'create' }, claimed: false });
    expect(rec.events.map((e) => [e.text, e.labels])).toEqual([['INSERT 1', { orm: 'prisma', model: 'User', operation: 'create' }]]);
  });

  it("isEnabled, getTraceParent and getActiveContext are the app's own, bound to the app", () => {
    const app = appHelper();
    const w = wrapAppHelper(app) as any;
    const { getTraceParent } = w;
    expect(getTraceParent()).toBe('00-aa-bb-01');
    expect(w.isEnabled()).toBe(true);
    expect(w.getActiveContext()).toBe(app.ctx);
    expect(app.getTraceParent.mock.contexts[0]).toBe(app);
  });

  it('6.1+: records statements from dispatchEngineSpans with the current labels, then delegates', () => {
    const app = appHelper();
    const w = wrapAppHelper(app) as any;
    const spans = [{ id: 'a', parentId: 'op', name: 'prisma:engine:db_query', startTime: [1, 0], endTime: [1, 4_000_000], attributes: { 'db.query.text': 'SELECT 9' } }];
    w.runInChildSpan(opSpan('findFirst', 'Post'), () => w.dispatchEngineSpans(spans, 'extra'));
    expect(app.dispatchEngineSpans).toHaveBeenCalledWith(spans, 'extra');
    expect(rec.events).toEqual([{ text: 'SELECT 9', database: null, durationMs: 4, failed: false, errorCode: null, labels: { orm: 'prisma', model: 'Post', operation: 'findFirst' } }]);
  });

  it('5.22/6.0: records statements from createEngineSpan with Prisma labels and no model, then delegates', () => {
    const app = appHelper();
    const w = wrapAppHelper(app) as any;
    const ev = { span: true, spans: [{ span_id: 's1', parent_span_id: 'p', name: 'prisma:engine:db_query', start_time: [2, 0], end_time: [2, 500_000], attributes: { 'db.statement': 'SELECT 7' } }] };
    w.createEngineSpan(ev);
    expect(app.createEngineSpan).toHaveBeenCalledWith(ev);
    expect(rec.events).toEqual([{ text: 'SELECT 7', database: null, durationMs: 0.5, failed: false, errorCode: null, labels: { orm: 'prisma', model: null, operation: null } }]);
  });

  it('records no engine or db_query statements when the pg wrap covers the adapter', () => {
    rt.pgCoversPrismaAdapter = true;
    const app = appHelper();
    const w = wrapAppHelper(app) as any;
    w.runInChildSpan(dbSpan('SELECT 1'), () => 1);
    w.dispatchEngineSpans([{ id: 'a', parentId: 'op', name: 'prisma:engine:db_query', startTime: [1, 0], endTime: [1, 1], attributes: { 'db.query.text': 'SELECT 1' } }]);
    w.createEngineSpan({ span: true, spans: [{ span_id: 's', name: 'prisma:engine:db_query', start_time: [1, 0], end_time: [1, 1], attributes: { 'db.statement': 'SELECT 1' } }] });
    expect(rec.events).toEqual([]);
    expect(app.dispatchEngineSpans).toHaveBeenCalledOnce();
    expect(app.createEngineSpan).toHaveBeenCalledOnce();
  });

  it('never throws from a malformed span; a throwing app helper method throws its own error, unchanged', () => {
    const app = appHelper();
    const w = wrapAppHelper(app) as any;
    expect(() => w.dispatchEngineSpans(null)).not.toThrow();
    expect(() => w.createEngineSpan(undefined)).not.toThrow();
    const err = new Error('app');
    app.dispatchEngineSpans.mockImplementation(() => { throw err; });
    app.runInChildSpan.mockImplementation(() => { throw err; });
    app.getTraceParent.mockImplementation(() => { throw err; });
    expect(() => w.dispatchEngineSpans([])).toThrow(err);
    expect(() => w.runInChildSpan(opSpan('m'), () => 1)).toThrow(err);
    expect(() => w.getTraceParent()).toThrow(err);
  });

  it('passes through a helper with no runInChildSpan, and other properties as they are', () => {
    const app = { isEnabled: () => false, getTraceParent: () => '00-10-10-00', n: 1 };
    const w = wrapAppHelper(app) as any;
    expect(w.runInChildSpan).toBeUndefined();
    expect(w.n).toBe(1);
    expect(w.isEnabled()).toBe(false);
  });
});

describe('engine spans', () => {
  it('statementsFromBatch skips db_query spans with a js:query child and times the rest', () => {
    const spans = [
      { id: 'a', parentId: 'op', name: 'prisma:engine:db_query', startTime: [1, 0], endTime: [1, 2_500_000], attributes: { 'db.query.text': 'SELECT 1' } },
      { id: 'b', parentId: 'op', name: 'prisma:engine:db_query', startTime: [1, 0], endTime: [1, 1_000_000], attributes: { 'db.query.text': 'SELECT 2' } },
      { id: 'c', parentId: 'b', name: 'prisma:engine:js:query:sql', startTime: [1, 0], endTime: [1, 1] },
    ];
    expect(statementsFromBatch(spans)).toEqual([{ text: 'SELECT 1', durationMs: 2.5 }]);
  });

  it('statementsFromBatch spans seconds, and skips malformed spans and other names', () => {
    const evil = { get name(): string { throw new Error('evil'); } };
    const spans = [
      null, 7, evil,
      { id: 'x', name: 'prisma:engine:db_query', startTime: [1, 900_000_000], endTime: [2, 100_000_000], attributes: { 'db.query.text': 'SELECT 1' } },
      { id: 'y', name: 'prisma:engine:db_query', startTime: [1, 0], endTime: [1, 1], attributes: {} },
      { id: 'z', name: 'prisma:engine:db_query', startTime: 'x', endTime: [1, 1], attributes: { 'db.query.text': 'SELECT 2' } },
      { id: 'w', name: 'prisma:engine:db_query', startTime: [2, 0], endTime: [1, 0], attributes: { 'db.query.text': 'SELECT 3' } },
      { id: 'v', name: 'prisma:engine:serialize', startTime: [1, 0], endTime: [1, 1], attributes: { 'db.query.text': 'SELECT 4' } },
    ];
    const out = statementsFromBatch(spans);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('SELECT 1');
    expect(out[0]!.durationMs).toBeCloseTo(200, 9);
    expect(statementsFromBatch(null)).toEqual([]);
    expect(statementsFromBatch({ length: 1, 0: spans[3] })).toEqual([]);
  });

  it('the legacy tracker skips a db_query whose js:query child arrived first, and bounds its id set', () => {
    const t = createLegacySpanTracker();
    const child = (id: string, parent: string) => ({ span: true, spans: [{ span_id: id, parent_span_id: parent, name: 'prisma:engine:js:query:sql', start_time: [1, 0], end_time: [1, 1] }] });
    const parent = (id: string, text: string) => ({ span: true, spans: [{ span_id: id, parent_span_id: 'op', name: 'prisma:engine:db_query', start_time: [1, 0], end_time: [1, 3_000_000], attributes: { 'db.statement': text } }] });
    expect(t.observe(child('c1', 'p1'))).toEqual([]);
    expect(t.observe(parent('p1', 'SELECT 1'))).toEqual([]);
    expect(t.observe(parent('p2', 'SELECT 2'))).toEqual([{ text: 'SELECT 2', durationMs: 3 }]);
    expect(t.size()).toBe(0); // the parent consumed its id

    for (let i = 0; i < 2_001; i++) t.observe(child(`c${i}`, `q${i}`));
    expect(t.size()).toBe(2_000);
    expect(t.observe(parent('q0', 'SELECT 0'))).toHaveLength(1); // the oldest id was evicted
    expect(t.observe(parent('q2000', 'SELECT 0'))).toEqual([]);

    const small = createLegacySpanTracker(2);
    for (const i of [1, 2, 3]) small.observe(child(`c${i}`, `r${i}`));
    expect(small.size()).toBe(2);
    expect(t.observe(null)).toEqual([]); expect(t.observe({ span: true, spans: 'x' })).toEqual([]);
  });
});

describe('pgCoversAdapter', () => {
  it('is true only when the adapter resolved and its pg Client prototype carries the pg wrap record', () => {
    class Client { query(): void {} }
    const mod = { Client };
    expect(pgCoversAdapter(true, mod)).toBe(false);
    Object.defineProperty(Client.prototype, PG_QUERY_WRAP, { value: { original: () => 1, wrapper: () => 1, hadOwn: true }, configurable: true });
    expect(pgCoversAdapter(true, mod)).toBe(true);
    expect(pgCoversAdapter(true, { default: { Client } })).toBe(true);
    expect(pgCoversAdapter(false, mod)).toBe(false);
    expect(pgCoversAdapter(true, null)).toBe(false);
    class Sub extends Client {}
    expect(pgCoversAdapter(true, { Client: Sub })).toBe(false); // the record must be the adapter's own Client.prototype
  });
});
