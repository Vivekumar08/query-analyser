import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sqlRuntime, type StatementFrame } from '../sql/context.js';
import { createSqlSink, type StatementEvent } from '../sql/core.js';
import { Aggregator } from '../aggregator.js';
import { installPgWrap, installPgPoolWrap, undoPgWraps, isAdapterShape, PG_QUERY_WRAP, PG_POOL_QUERY_WRAP } from './pg.js';


type Behaviour = { ok: unknown } | { fail: unknown };
type Cb = (this: unknown, err: unknown, res?: unknown) => unknown;
type Cfg = { text?: unknown; values?: unknown; callback?: unknown; submit?: unknown; [k: string]: unknown };

/** The `this` pg calls a callback with (its Query object). */
const QUERY_THIS = { the: 'query' };

/**
 * Behaves like pg 8's Client.prototype.query (pg/lib/client.js:668 and utils.normalizeQueryConfig):
 * null throws; a submittable comes back as is; `values`/`callback` are written onto the config
 * (the callback argument wins over a function in `values`); a callback is called on the next
 * tick with (err, res); otherwise a promise from the client's Promise constructor.
 */
class FakeClient {
  database: unknown = 'shop';
  Promise: PromiseConstructorLike = Promise;
  /** What the original received, for assertions. */
  seen: { config: unknown; values: unknown; callback: unknown } | null = null;
  /** What the original returned. */
  returned: unknown = undefined;
  constructor(private behave: Behaviour) {}
  query(config?: unknown, values?: unknown, callback?: unknown): unknown {
    this.seen = { config, values, callback };
    if (config == null) throw new TypeError('Client was passed a null or undefined query');
    if (typeof (config as Cfg).submit === 'function') return config;
    const c = (typeof config === 'string' ? { text: config } : config) as Cfg;
    if (values) { if (typeof values === 'function') c.callback = values; else c.values = values; }
    if (callback) c.callback = callback;
    const settle = (cb: Cb): void => {
      process.nextTick(() => { if ('fail' in this.behave) cb.call(QUERY_THIS, this.behave.fail); else cb.call(QUERY_THIS, null, this.behave.ok); });
    };
    if (!c.callback) {
      this.returned = new (this.Promise as PromiseConstructor)((resolve, reject) => settle((err, res) => (err ? reject(err) : resolve(res))));
      return this.returned;
    }
    if (typeof c.callback !== 'function') throw new TypeError('callback is not a function');
    settle(c.callback as Cb);
    return undefined;
  }
}

let recorded: StatementEvent[];
let onError: ReturnType<typeof vi.fn>;

function useRecordingSink(): void {
  const real = createSqlSink({
    aggregator: new Aggregator(100), thresholdMs: 100, sampleRate: 1, maskIdentifiers: false, isDisabled: () => false,
    onError: (e: Error) => onError(e),
  });
  sqlRuntime().sink = { record: (ev) => { recorded.push(ev); real.record(ev); } };
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  recorded = [];
  onError = vi.fn();
  useRecordingSink();
  sqlRuntime().prismaAdapterResolved = false;
  installPgWrap(FakeClient);
});

afterEach(() => {
  undoPgWraps();
  sqlRuntime().sink = null;
  sqlRuntime().prismaAdapterResolved = false;
});

describe('pg wrapper: promise form', () => {
  it('hands pg the very arguments object, with no copy (Reflect.apply on arguments)', async () => {
    const c = new FakeClient({ ok: {} });
    const slice = vi.spyOn(Array.prototype, 'slice');
    const p = c.query('SELECT 1', [1]);
    const slices = slice.mock.calls.length;
    slice.mockRestore();
    await p;
    expect(slices).toBe(0);
    expect(c.seen!.config).toBe('SELECT 1');
  });

  it('promise form: resolves with the same value and records once', async () => {
    const res = { rows: [{ a: 1 }] }; const c = new FakeClient({ ok: res });
    await expect(c.query('SELECT 1')).resolves.toBe(res);
    expect(recorded).toEqual([expect.objectContaining({ text: 'SELECT 1', database: 'shop', failed: false, labels: null })]);
    expect(recorded[0]!.errorCode).toBeNull();
    expect(typeof recorded[0]!.durationMs).toBe('number');
    expect(recorded[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('promise form: rejects with the same error object and records its SQLSTATE only', async () => {
    const err = Object.assign(new Error('dup'), { code: '23505', detail: 'Key (email)=(a@b.c)' });
    await expect(new FakeClient({ fail: err }).query('INSERT …')).rejects.toBe(err);
    expect(recorded[0]).toMatchObject({ failed: true, errorCode: '23505' });
    expect(JSON.stringify(recorded)).not.toContain('a@b.c');
    expect(JSON.stringify(recorded)).not.toContain('dup');
  });

  it('reads config.text from a config object', async () => {
    await new FakeClient({ ok: {} }).query({ text: 'SELECT 2', values: [1] });
    expect(recorded).toEqual([expect.objectContaining({ text: 'SELECT 2', failed: false })]);
  });

  it('Review Focus: an ignored failing promise still raises exactly one unhandledRejection with the same error', async () => {
    // Take vitest's own listeners off for the duration, so the event reaches only ours.
    const saved = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const seen: unknown[] = []; const on = (e: unknown): void => { seen.push(e); };
    process.on('unhandledRejection', on);
    try {
      const err = new Error('boom'); void new FakeClient({ fail: err }).query('SELECT 1'); // never awaited
      await tick(20);
      expect(seen).toEqual([err]);
      expect(seen[0]).toBe(err);
      expect(recorded).toEqual([expect.objectContaining({ failed: true })]);
    } finally {
      process.off('unhandledRejection', on);
      for (const l of saved) process.on('unhandledRejection', l as (...a: unknown[]) => void);
    }
  });

  it('Review Focus: the same holds with no SDK (control): exactly one event with the same error', async () => {
    undoPgWraps();
    const saved = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const seen: unknown[] = []; const on = (e: unknown): void => { seen.push(e); };
    process.on('unhandledRejection', on);
    try {
      const err = new Error('boom'); void new FakeClient({ fail: err }).query('SELECT 1');
      await tick(20);
      expect(seen).toEqual([err]);
    } finally {
      process.off('unhandledRejection', on);
      for (const l of saved) process.on('unhandledRejection', l as (...a: unknown[]) => void);
    }
  });

  it("keeps the client's Promise constructor", async () => {
    class MyPromise<T> extends Promise<T> {}
    const c = new FakeClient({ ok: {} }); c.Promise = MyPromise;
    const p = c.query('SELECT 1');
    expect(p).toBeInstanceOf(MyPromise);
    await p;
  });

  it('is a pure pass-through with no sink: same promise object, no timing', async () => {
    sqlRuntime().sink = null;
    const c = new FakeClient({ ok: {} });
    const p = c.query('SELECT 1');
    expect(p).toBe(c.returned);
    await p;
    expect(recorded).toHaveLength(0);
  });

  it('a wrapped promise is not the original object, but settles the same way', async () => {
    const c = new FakeClient({ ok: 7 });
    const p = c.query('SELECT 1');
    expect(p).not.toBe(c.returned);
    await expect(p).resolves.toBe(7);
  });
});

/** Calls query with a callback and resolves with what the callback saw. */
function viaCallback(run: (cb: Cb) => void): Promise<{ self: unknown; args: unknown[] }> {
  return new Promise((resolve) => {
    run(function (this: unknown, _err: unknown, _res?: unknown) { resolve({ self: this, args: [...arguments] }); });
  });
}

describe('pg wrapper: callback forms', () => {
  it('callback in values position: same (err, res), same this, same arity, called once', async () => {
    const res = { rows: [] }; const c = new FakeClient({ ok: res });
    const cb = vi.fn(function (this: unknown, _err: unknown, _res: unknown) { /* app callback */ });
    let ret: unknown = 'unset';
    await new Promise<void>((r) => { ret = c.query('SELECT 1', (e: unknown, x: unknown) => { cb.call(QUERY_THIS, e, x); r(); }); });
    expect(ret).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null, res);
    const passed = c.seen!.values as (...a: unknown[]) => unknown;
    expect(typeof passed).toBe('function');
    expect(passed.length).toBe(2);
    expect(recorded).toEqual([expect.objectContaining({ text: 'SELECT 1', failed: false })]);
  });

  it('callback in callback position keeps arity, this and arguments, and records the failure', async () => {
    const err = Object.assign(new Error('nope'), { code: '42P01' });
    const c = new FakeClient({ fail: err });
    const values = [1, 2];
    const seen = await viaCallback((cb) => { c.query('SELECT $1', values, cb); });
    expect(seen.self).toBe(QUERY_THIS);
    expect(seen.args).toEqual([err]);
    expect(seen.args[0]).toBe(err);
    expect(c.seen!.values).toBe(values);
    expect((c.seen!.callback as Cb).length).toBe(2);
    expect(recorded).toEqual([expect.objectContaining({ text: 'SELECT $1', failed: true, errorCode: '42P01' })]);
  });

  it('keeps a callback arity other than 2', async () => {
    const c = new FakeClient({ ok: {} });
    await new Promise<void>((r) => { c.query('SELECT 1', [], function three(_a: unknown, _b: unknown, _c: unknown) { r(); }); });
    expect((c.seen!.callback as Cb).length).toBe(3);
  });

  // Final ruling (perf): arities 0-3 use fixed-arity templates, with no defineProperty per query.
  const arityCallbacks: Array<[number, (done: (self: unknown, args: unknown[]) => void) => Cb]> = [
    [0, (done) => function (this: unknown) { done(this, [...arguments]); } as Cb],
    [1, (done) => function (this: unknown, _e: unknown) { done(this, [...arguments]); } as Cb],
    [2, (done) => function (this: unknown, _e: unknown, _r: unknown) { done(this, [...arguments]); } as Cb],
    [3, (done) => function (this: unknown, _e: unknown, _r: unknown, _x: unknown) { done(this, [...arguments]); } as Cb],
  ];
  for (const [arity, make] of arityCallbacks) {
    it(`a callback of arity ${arity} keeps its length, this and every argument, with no defineProperty per query`, async () => {
      const res = { rows: [] }; const c = new FakeClient({ ok: res });
      const define = vi.spyOn(Object, 'defineProperty');
      let seen: { self: unknown; args: unknown[] } | undefined;
      const settled = new Promise<void>((r) => { c.query('SELECT 1', [], make((self, args) => { seen = { self, args }; r(); })); });
      // On a function other than the spy itself (vitest's spy defines its own `mock` on first call).
      const defines = define.mock.calls.filter(([target]) => typeof target === 'function' && target !== (define as unknown)).length;
      define.mockRestore();
      await settled;
      expect(defines).toBe(0);
      expect((c.seen!.callback as Cb).length).toBe(arity);
      expect(seen).toEqual({ self: QUERY_THIS, args: [null, res] });
      expect(seen!.args[1]).toBe(res);
      await tick();
      expect(recorded).toEqual([expect.objectContaining({ text: 'SELECT 1', failed: false })]);
    });
  }

  it('a callback of arity 4 or more still keeps its length', async () => {
    const c = new FakeClient({ ok: {} });
    await new Promise<void>((r) => { c.query('SELECT 1', [], function four(_a: unknown, _b: unknown, _c: unknown, _d: unknown) { r(); }); });
    expect((c.seen!.callback as Cb).length).toBe(4);
  });

  it('the callback argument wins over a function in values, as in pg, and is recorded once', async () => {
    const c = new FakeClient({ ok: {} });
    const ignored = vi.fn();
    await new Promise<void>((r) => { c.query('SELECT 1', ignored, () => r()); });
    await tick();
    expect(ignored).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
  });

  it('config.callback form is captured and still receives (err, res)', async () => {
    const res = { rows: [{ n: 1 }] }; const c = new FakeClient({ ok: res });
    const seen = await viaCallback((cb) => { c.query({ text: 'SELECT 3', callback: cb }); });
    expect(seen.args).toEqual([null, res]);
    expect(seen.self).toBe(QUERY_THIS);
    expect(recorded).toEqual([expect.objectContaining({ text: 'SELECT 3', failed: false })]);
    // pg read every other field through the prototype of the config it was given
    const given = c.seen!.config as Cfg;
    expect(given.text).toBe('SELECT 3');
    expect((given.callback as Cb).length).toBe(2);
  });

  it('config.callback form hands pg an object that inherits every field from the app config', async () => {
    const c = new FakeClient({ ok: {} });
    const cfg: Cfg = { text: 'SELECT 4', rowMode: 'array' };
    await new Promise<void>((r) => { cfg.callback = () => r(); c.query(cfg); });
    const given = c.seen!.config as Cfg;
    expect(given).not.toBe(cfg);
    expect(Object.getPrototypeOf(given)).toBe(cfg);
    expect(Object.keys(given)).toEqual(['callback']);
    expect(given.rowMode).toBe('array');
    expect(Object.keys(cfg)).toEqual(['text', 'rowMode', 'callback']);
  });

  it('a config reused after pg wrote a wrapped callback onto it is still recorded once per call', async () => {
    const c = new FakeClient({ ok: {} });
    const cfg: Cfg = { text: 'SELECT 5' };
    let calls = 0;
    await new Promise<void>((r) => { c.query(cfg, () => { calls++; r(); }); });
    await new Promise<void>((r) => { c.query(cfg); setTimeout(r, 5); });
    expect(calls).toBe(2);
    expect(recorded).toHaveLength(2);
  });

  it('a throwing app callback still throws out of pg, after recording', async () => {
    const c = new FakeClient({ ok: {} });
    const boom = new Error('app bug');
    const seen: unknown[] = [];
    const saved = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    const on = (e: unknown): void => { seen.push(e); };
    process.on('uncaughtException', on);
    try {
      c.query('SELECT 1', () => { throw boom; });
      await tick(10);
      expect(seen).toEqual([boom]);
      expect(recorded).toHaveLength(1);
    } finally {
      process.off('uncaughtException', on);
      for (const l of saved) process.on('uncaughtException', l as (...a: unknown[]) => void);
    }
  });

  it('a non-function callback passes through so pg throws its own error', () => {
    const c = new FakeClient({ ok: {} });
    expect(() => c.query({ text: 'SELECT 1', callback: 42 })).toThrow('callback is not a function');
    expect(c.seen!.config).toEqual({ text: 'SELECT 1', callback: 42 });
    expect(recorded).toHaveLength(0);
  });
});

describe('pg wrapper: pass-through cases', () => {
  it('Review Focus: a submittable passes through untouched and uncounted', () => {
    const sub = { text: 'SELECT 1', submit: vi.fn(), on: vi.fn() };
    expect(new FakeClient({ ok: {} }).query(sub)).toBe(sub);
    expect(recorded).toHaveLength(0); expect(onError).not.toHaveBeenCalled();
  });

  it('Review Focus: a submittable with a callback argument reaches pg as the same objects', () => {
    const sub = { text: 'SELECT 1', submit: vi.fn() };
    const cb = (): void => {};
    const c = new FakeClient({ ok: {} });
    expect(c.query(sub, cb)).toBe(sub);
    expect(c.seen!.config).toBe(sub);
    expect(c.seen!.values).toBe(cb);
    expect(recorded).toHaveLength(0);
  });

  it('a synchronous throw is re-thrown unchanged and records nothing', () => {
    expect(() => new FakeClient({ ok: {} }).query(null)).toThrow('Client was passed a null or undefined query');
    expect(() => new FakeClient({ ok: {} }).query(undefined)).toThrow(TypeError);
    expect(recorded).toHaveLength(0);
  });

  it('a synchronous throw from the original in the promise form is the same error object', () => {
    const err = new Error('sync');
    class Throws { query(): never { throw err; } }
    installPgWrap(Throws);
    try { new Throws().query(); expect.unreachable(); } catch (e) { expect(e).toBe(err); }
    expect(() => (new Throws().query as (c: string) => unknown)('SELECT 1')).toThrow(err);
    expect(recorded).toHaveLength(0);
  });

  it('a text that is not a string passes through untouched', async () => {
    const c = new FakeClient({ ok: {} });
    const cfg = { text: 42 };
    const p = c.query(cfg);
    expect(p).toBe(c.returned);
    await p;
    expect(recorded).toHaveLength(0);
  });
});

/** A Proxy whose every property read throws (except `then`, which Promise resolution itself reads). */
function untouchable<T extends object>(target: T, name: string): T {
  return new Proxy(target, {
    get(t, k) {
      if (k === 'then') return undefined;
      throw new Error(`the SDK read ${name}.${String(k)}`);
    },
  });
}

describe('pg wrapper: privacy and labels', () => {
  it('never reads values, the result or connection fields', async () => {
    const res = untouchable({ rows: [] }, 'result');
    const c = new FakeClient({ ok: res });
    for (const k of ['password', 'user', 'host', 'port', 'connectionString', 'connectionParameters']) {
      Object.defineProperty(c, k, { get() { throw new Error(`the SDK read client.${k}`); } });
    }
    const values = untouchable([1, 'secret'], 'values');
    await expect(c.query('SELECT $1, $2', values)).resolves.toBe(res);
    await expect(c.query({ text: 'SELECT $1', values })).resolves.toBe(res);
    await new Promise<void>((r) => { c.query('SELECT $1', values, () => r()); });
    expect(recorded).toHaveLength(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a database that is not a string is recorded as null', async () => {
    const c = new FakeClient({ ok: {} }); c.database = undefined;
    await c.query('SELECT 1');
    expect(recorded[0]!.database).toBeNull();
  });

  it('a throwing database getter does not reach the app', async () => {
    const c = new FakeClient({ ok: 1 });
    Object.defineProperty(c, 'database', { get() { throw new Error('getter'); } });
    await expect(c.query('SELECT 1')).resolves.toBe(1);
  });

  it('inside an unclaimed statement frame: claims it and takes the Prisma labels', async () => {
    const c = new FakeClient({ ok: {} });
    const frame: StatementFrame = { kind: 'statement', op: { kind: 'operation', model: 'User', operation: 'findMany' }, claimed: false };
    await sqlRuntime().als.run(frame, () => c.query('SELECT 1'));
    expect(frame.claimed).toBe(true); expect(recorded[0]!.labels).toEqual({ orm: 'prisma', model: 'User', operation: 'findMany' });
  });

  it('inside an operation frame: takes its labels', async () => {
    const c = new FakeClient({ ok: {} });
    await sqlRuntime().als.run({ kind: 'operation', model: null, operation: '$queryRaw' }, () => c.query('SELECT 1'));
    expect(recorded[0]!.labels).toEqual({ orm: 'prisma', model: null, operation: '$queryRaw' });
  });

  it('a malformed cross-version frame (no op) is labelled Prisma with no model, not a crash', async () => {
    const c = new FakeClient({ ok: {} });
    const frame = { kind: 'statement', claimed: false } as unknown as StatementFrame;
    await sqlRuntime().als.run(frame, () => c.query('SELECT 1'));
    expect(recorded[0]!.labels).toEqual({ orm: 'prisma', model: null, operation: null });
  });

  it('a frozen statement frame still records', async () => {
    const c = new FakeClient({ ok: {} });
    const frame = Object.freeze({ kind: 'statement', op: null, claimed: false }) as StatementFrame;
    await sqlRuntime().als.run(frame, () => c.query('SELECT 1'));
    expect(recorded).toHaveLength(1);
  });

  it('infers the prisma ORM label from the adapter call shape only when the adapter was resolved', async () => {
    const c = new FakeClient({ ok: {} });
    const cfg = { text: 'SELECT 1', values: [], rowMode: 'array', types: { getTypeParser: () => String } };
    sqlRuntime().prismaAdapterResolved = false; await c.query(cfg); expect(recorded[0]!.labels).toBeNull();
    sqlRuntime().prismaAdapterResolved = true; await c.query(cfg); expect(recorded[1]!.labels).toEqual({ orm: 'prisma', model: null, operation: null });
    await c.query({ text: 'SELECT 1' }); expect(recorded[2]!.labels).toBeNull();
  });

  it('isAdapterShape', () => {
    const types = { getTypeParser: () => String };
    expect(isAdapterShape({ rowMode: 'array', types })).toBe(true);
    expect(isAdapterShape({ rowMode: 'array' })).toBe(false);
    expect(isAdapterShape({ rowMode: 'array', types: {} })).toBe(false);
    expect(isAdapterShape({ rowMode: 'array', types: null })).toBe(false);
    expect(isAdapterShape({ types })).toBe(false);
    expect(isAdapterShape('SELECT 1')).toBe(false);
    expect(isAdapterShape(null)).toBe(false);
    expect(isAdapterShape(untouchable({}, 'config'))).toBe(false);
  });
});

describe('pg wrapper: never throws', () => {
  it('never throws when recording fails', async () => {
    sqlRuntime().sink = { record: () => { throw new Error('sink'); } };
    const c = new FakeClient({ ok: 1 });
    await expect(c.query('SELECT 1')).resolves.toBe(1);
    const err = new Error('db');
    await expect(new FakeClient({ fail: err }).query('SELECT 1')).rejects.toBe(err);
    const seen = await viaCallback((cb) => { c.query('SELECT 1', cb); });
    expect(seen.args).toEqual([null, 1]);
  });

  it('a config whose getters throw passes straight to pg', () => {
    const c = new FakeClient({ ok: {} });
    const cfg = untouchable({}, 'config');
    expect(() => c.query(cfg)).toThrow(/the SDK read config\./);
    expect(c.seen!.config).toBe(cfg);
  });

  it('a failure inside the runtime (getStore throws) passes through', async () => {
    const spy = vi.spyOn(sqlRuntime().als, 'getStore').mockImplementation(() => { throw new Error('als'); });
    try {
      const c = new FakeClient({ ok: 1 });
      const p = c.query('SELECT 1');
      expect(p).toBe(c.returned);
      await expect(p).resolves.toBe(1);
    } finally { spy.mockRestore(); }
  });
});

interface Rec { original: unknown; wrapper: unknown; hadOwn: boolean }
const recOf = (proto: object): Rec | undefined => Object.getOwnPropertyDescriptor(proto, PG_QUERY_WRAP)?.value as Rec | undefined;

describe('installPgWrap / undoPgWraps', () => {
  it('wraps once across SDK copies and undo restores only when on top', async () => {
    class A { query(_c?: unknown): unknown { return Promise.resolve('a'); } }
    const original = A.prototype.query;
    expect(installPgWrap(A)).toBe(true);
    expect(installPgWrap(A)).toBe(false);
    const rec = recOf(A.prototype)!;
    expect(rec).toMatchObject({ original, hadOwn: true });
    expect(A.prototype.query).toBe(rec.wrapper);
    const symDesc = Object.getOwnPropertyDescriptor(A.prototype, PG_QUERY_WRAP)!;
    expect(symDesc.enumerable).toBe(false);
    // the descriptor's flags are kept (class methods: writable, non-enumerable, configurable)
    expect(Object.getOwnPropertyDescriptor(A.prototype, 'query')).toMatchObject({ writable: true, enumerable: false, configurable: true });

    // a foreign wrapper on top: undo leaves it; ours stays below as a pass-through
    const ours = A.prototype.query;
    const foreign = function query(this: A, ...args: unknown[]): unknown { return (ours as (...a: unknown[]) => unknown).apply(this, args); };
    A.prototype.query = foreign as never;
    undoPgWraps();
    expect(A.prototype.query).toBe(foreign);
    await expect(new A().query('SELECT 1')).resolves.toBe('a');
    expect(recorded).toHaveLength(0);

    // re-install switches the buried wrapper back on instead of stacking
    expect(installPgWrap(A)).toBe(false);
    await new A().query('SELECT 1');
    expect(recorded).toHaveLength(1);
  });

  it('undo restores the original when the wrapper is on top', () => {
    class B { query(): unknown { return 'b'; } }
    const original = B.prototype.query;
    installPgWrap(B);
    undoPgWraps();
    expect(B.prototype.query).toBe(original);
    expect(Object.getOwnPropertySymbols(B.prototype)).not.toContain(PG_QUERY_WRAP);
  });

  it('the inherited case: undo deletes the own property', () => {
    class Base { query(): unknown { return 'base'; } }
    class Sub extends Base {}
    // a Sub prototype that inherits query from an unwrapped Base
    expect(installPgWrap(Sub)).toBe(true);
    expect(recOf(Sub.prototype)!.hadOwn).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Sub.prototype, 'query')).toBe(true);
    undoPgWraps();
    expect(Object.prototype.hasOwnProperty.call(Sub.prototype, 'query')).toBe(false);
    expect(new Sub().query()).toBe('base');
  });

  it('a prototype that inherits an SDK wrapper is not wrapped again', async () => {
    class Base2 { query(_c?: unknown): unknown { return Promise.resolve('x'); } }
    class Sub2 extends Base2 {}
    expect(installPgWrap(Base2)).toBe(true);
    expect(installPgWrap(Sub2)).toBe(false);
    await new Sub2().query('SELECT 1');
    expect(recorded).toHaveLength(1);
  });

  it('a record from another SDK copy blocks wrapping', () => {
    class C { query(): unknown { return 'c'; } }
    const foreignWrapper = function query(): unknown { return 'w'; };
    Object.defineProperty(C.prototype, PG_QUERY_WRAP, { value: { original: C.prototype.query, wrapper: foreignWrapper, hadOwn: true }, enumerable: false, configurable: true });
    C.prototype.query = foreignWrapper as never;
    expect(installPgWrap(C)).toBe(false);
    expect(C.prototype.query).toBe(foreignWrapper);
  });

  it('keeps a non-default descriptor', () => {
    function D(): void {}
    Object.defineProperty(D.prototype, 'query', { value: () => 'd', writable: false, enumerable: true, configurable: true });
    expect(installPgWrap(D)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(D.prototype, 'query')).toMatchObject({ writable: false, enumerable: true, configurable: true });
  });

  it('never throws on bad input', () => {
    expect(installPgWrap(undefined)).toBe(false);
    expect(installPgWrap({})).toBe(false);
    expect(installPgWrap(function NoQuery() {})).toBe(false);
    function Frozen(): void {}
    Frozen.prototype.query = (): void => {};
    Object.freeze(Frozen.prototype);
    expect(installPgWrap(Frozen)).toBe(false);
    expect(() => undoPgWraps()).not.toThrow();
  });

  it('the wrapper keeps the name query and length 3 (pg 8 signature: config, values, callback)', () => {
    expect(FakeClient.prototype.query.name).toBe('query');
    expect(FakeClient.prototype.query.length).toBe(3);
  });
});

/**
 * Behaves like pg-pool 3's Pool.prototype.query (pg-pool/index.js:431-486) with `max` clients:
 * a values function becomes the callback; it checks out a client (now, or queued until one is
 * released) and calls `client.query(text, values, cb)` with the caller's own config object.
 * A queued request is served synchronously from release, i.e. in the releaser's async context,
 * as pg-pool does (it has no AsyncResource).
 */
class FakePool {
  Promise: PromiseConstructorLike = Promise;
  private idle: FakeClient[] = [];
  private waiting: ((c: FakeClient) => void)[] = [];
  constructor(clients: FakeClient[]) { this.idle = [...clients]; }
  private connect(cb: (c: FakeClient) => void): void {
    const c = this.idle.shift();
    if (c) process.nextTick(() => cb(c)); else this.waiting.push(cb);
  }
  private release(c: FakeClient): void {
    const next = this.waiting.shift();
    if (next) next(c); else this.idle.push(c);
  }
  query(text?: unknown, values?: unknown, cb?: unknown): unknown {
    if (typeof values === 'function') { cb = values; values = undefined; }
    let result: unknown;
    let done = cb as Cb | undefined;
    if (!done) {
      result = new (this.Promise as PromiseConstructor)((resolve, reject) => { done = (err, res) => (err ? reject(err) : resolve(res)); });
    }
    this.connect((client) => {
      client.query(text, values, (err: unknown, res: unknown) => { this.release(client); done!(err, res); });
    });
    return result;
  }
}

const opFrame = (model: string): StatementFrame => ({ kind: 'statement', op: { kind: 'operation', model, operation: 'findMany' }, claimed: false });

describe('pg wrapper: Pool.prototype.query keeps the caller frame', () => {
  beforeEach(() => { installPgPoolWrap(FakePool); });

  it('Important: under contention (max 1) each statement keeps its own frame and claims it', async () => {
    const pool = new FakePool([new FakeClient({ ok: {} })]);
    const frames = [opFrame('A'), opFrame('B'), opFrame('C')];
    const cfg = (): Cfg => ({ text: 'SELECT 1', values: [], rowMode: 'array', types: { getTypeParser: () => String } });
    await Promise.all(frames.map((f) => sqlRuntime().als.run(f, () => pool.query(cfg()))));
    expect(recorded.map((r) => r.labels?.model)).toEqual(['A', 'B', 'C']);
    expect(frames.map((f) => f.claimed)).toEqual([true, true, true]);
  });

  it('a queued caller with no frame does not inherit the releaser frame', async () => {
    const pool = new FakePool([new FakeClient({ ok: {} })]);
    const a = opFrame('A');
    const pa = sqlRuntime().als.run(a, () => pool.query({ text: 'SELECT 1' }));
    const pb = pool.query({ text: 'SELECT 2' });
    await Promise.all([pa, pb]);
    expect(recorded.map((r) => [r.text, r.labels?.model ?? null])).toEqual([['SELECT 1', 'A'], ['SELECT 2', null]]);
  });

  it('callback forms through the pool keep their frame', async () => {
    const pool = new FakePool([new FakeClient({ ok: 1 })]);
    const run = (m: string): Promise<unknown> => new Promise((r) => { sqlRuntime().als.run(opFrame(m), () => { pool.query({ text: 'SELECT 1' }, (_e: unknown, x: unknown) => r(x)); }); });
    await expect(Promise.all([run('A'), run('B')])).resolves.toEqual([1, 1]);
    expect(recorded.map((r) => r.labels?.model)).toEqual(['A', 'B']);
  });

  it('the pool wrapper hands pg-pool the same arguments and returns its result', async () => {
    const pool = new FakePool([new FakeClient({ ok: 5 })]);
    const cfg = { text: 'SELECT 1' };
    const values = [1];
    const c = (pool as unknown as { idle: FakeClient[] }).idle[0]!;
    await expect(pool.query(cfg, values)).resolves.toBe(5);
    expect(c.seen!.values).toBe(values);
    expect(Object.getPrototypeOf(c.seen!.config) === cfg || c.seen!.config === cfg).toBe(true);
    await expect(pool.query('SELECT 2')).resolves.toBe(5);
    expect(recorded.map((r) => r.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('a stashed frame is consumed once: a later direct client.query with the same config reads its own context', async () => {
    const client = new FakeClient({ ok: {} });
    const pool = new FakePool([client]);
    const cfg = { text: 'SELECT 1' };
    await sqlRuntime().als.run(opFrame('A'), () => pool.query(cfg));
    // pg wrote pg-pool's callback onto cfg (normalizeQueryConfig), so this reuse takes the config.callback form
    await sqlRuntime().als.run(opFrame('B'), () => client.query(cfg));
    await tick();
    expect(recorded.map((r) => r.labels?.model)).toEqual(['A', 'B']);
  });

  it('with no sink the pool wrapper is a pure pass-through', async () => {
    sqlRuntime().sink = null;
    const pool = new FakePool([new FakeClient({ ok: 1 })]);
    await expect(pool.query({ text: 'SELECT 1' })).resolves.toBe(1);
    expect(recorded).toHaveLength(0);
  });

  it('the pool wrapper never throws: a config whose getters throw still reaches pg-pool', () => {
    const pool = new FakePool([]);
    expect(() => pool.query(untouchable({}, 'config'))).not.toThrow();
  });
});

describe('installPgPoolWrap / undoPgWraps', () => {
  it('wraps once, keeps flags, and undo restores the original', () => {
    class P { query(): unknown { return 'p'; } }
    const original = P.prototype.query;
    expect(installPgPoolWrap(P)).toBe(true);
    expect(installPgPoolWrap(P)).toBe(false);
    const rec = Object.getOwnPropertyDescriptor(P.prototype, PG_POOL_QUERY_WRAP)!;
    expect(rec.enumerable).toBe(false);
    expect(rec.value).toMatchObject({ original, hadOwn: true });
    expect(Object.getOwnPropertyDescriptor(P.prototype, 'query')).toMatchObject({ writable: true, enumerable: false, configurable: true });
    expect(new P().query()).toBe('p');
    undoPgWraps();
    expect(P.prototype.query).toBe(original);
    expect(Object.getOwnPropertySymbols(P.prototype)).not.toContain(PG_POOL_QUERY_WRAP);
  });

  it("pg's BoundPool case: query inherited from pg-pool's Pool; undo deletes the own property", () => {
    class PgPoolPool { query(): unknown { return 'base'; } }
    class BoundPool extends PgPoolPool {}
    expect(installPgPoolWrap(BoundPool)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(BoundPool.prototype, 'query')).toBe(true);
    undoPgWraps();
    expect(Object.prototype.hasOwnProperty.call(BoundPool.prototype, 'query')).toBe(false);
    expect(new BoundPool().query()).toBe('base');
  });

  it('two BoundPools over one pg-pool are each wrapped once; a subclass of a wrapped pool is not', () => {
    class PgPoolPool { query(): unknown { return 'base'; } }
    class B1 extends PgPoolPool {}
    class B2 extends PgPoolPool {}
    class Sub extends B1 {}
    expect(installPgPoolWrap(B1)).toBe(true);
    expect(installPgPoolWrap(B2)).toBe(true);
    expect(installPgPoolWrap(Sub)).toBe(false);
  });

  it('a foreign wrapper on top: undo leaves it and ours becomes a pass-through; re-install revives it', async () => {
    const pool = (): FakePool => new FakePool([new FakeClient({ ok: {} })]);
    installPgPoolWrap(FakePool);
    const ours = FakePool.prototype.query;
    const foreign = function query(this: FakePool, ...a: unknown[]): unknown { return (ours as (...x: unknown[]) => unknown).apply(this, a); };
    FakePool.prototype.query = foreign as never;
    try {
      undoPgWraps();
      installPgWrap(FakeClient);
      await sqlRuntime().als.run(opFrame('A'), () => pool().query({ text: 'SELECT 1' }));
      expect(FakePool.prototype.query).toBe(foreign);
      expect(installPgPoolWrap(FakePool)).toBe(false);
      await sqlRuntime().als.run(opFrame('B'), () => pool().query({ text: 'SELECT 1' }));
      expect(recorded.map((r) => r.labels?.model)).toEqual(['A', 'B']);
    } finally {
      undoPgWraps();
      FakePool.prototype.query = ours as never;
      undoPgWraps();
    }
  });

  it('never throws on bad input', () => {
    expect(installPgPoolWrap(undefined)).toBe(false);
    expect(installPgPoolWrap(function NoQuery() {})).toBe(false);
  });
});

describe('pg wrapper: recording does not run before the app gets its result', () => {
  it('callback form: the frame is claimed before the callback runs; the record follows, exactly once', async () => {
    const c = new FakeClient({ ok: {} });
    const frame = opFrame('A');
    const atCallback = await new Promise<{ claimed: boolean; records: number }>((r) => {
      sqlRuntime().als.run(frame, () => { c.query('SELECT 1', () => r({ claimed: frame.claimed, records: recorded.length })); });
    });
    expect(atCallback).toEqual({ claimed: true, records: 0 });
    await tick();
    expect(recorded).toHaveLength(1);
  });

  it('promise form: the frame is claimed before the value is delivered; the record happens exactly once', async () => {
    const c = new FakeClient({ ok: 1 });
    const frame = opFrame('A');
    let claimedAtValue: boolean | null = null;
    const p = sqlRuntime().als.run(frame, () => c.query('SELECT 1')) as Promise<unknown>;
    // a handler attached directly runs in the same job as ours: the claim is set, the record is not yet made
    void p.then(() => { claimedAtValue = frame.claimed; });
    await p;
    expect(claimedAtValue).toBe(true);
    await tick();
    expect(recorded).toHaveLength(1);
  });

  it('a record deferred to a microtask that throws never reaches the app', async () => {
    sqlRuntime().sink = { record: () => { throw new Error('sink'); } };
    const saved = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    const seen: unknown[] = []; const on = (e: unknown): void => { seen.push(e); };
    process.on('uncaughtException', on);
    try {
      await new Promise<void>((r) => { new FakeClient({ ok: {} }).query('SELECT 1', () => r()); });
      await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off('uncaughtException', on);
      for (const l of saved) process.on('uncaughtException', l as (...a: unknown[]) => void);
    }
  });
});
