import { sqlRuntime, labelsOf, type Labels, type SqlFrame, type SqlRuntime } from '../sql/context.js';
import { sqlStateOf } from '../sql/core.js';

/**
 * The `pg` choke point: `Client.prototype.query` (pg/lib/client.js:668 in 8.23, :481 in 8.0).
 * Every statement reaches it, from `Pool.query`, a pool client, or `@prisma/adapter-pg`
 * (spike Q1). The wrapper times each statement and hands it to the SQL sink.
 *
 * It never changes what pg sees or what the app gets back:
 * - the same arguments (a callback is swapped for one with the same `length` that calls it with
 *   the same `this` and arguments; a `config.callback` is supplied through `Object.create(config)`);
 * - the same result, the same error object, the same synchronous throw;
 * - for the promise form, `p.then(record-and-return, record-and-rethrow)`: the client's Promise
 *   constructor is kept, and an ignored rejection still raises exactly one `unhandledRejection`
 *   with the same error (Review Focus; Decision 7);
 * - a submittable (`pg-cursor`, `pg-query-stream`, `new pg.Query`) is passed straight through.
 *
 * It reads only the SQL text, `client.database` and an error's `code` (privacy rule).
 * Every SDK step is guarded; its failures are swallowed (the sink reports its own).
 */

type QueryFn = (this: unknown, ...args: unknown[]) => unknown;
type Callback = (this: unknown, ...args: unknown[]) => unknown;

interface PgWrapRecord {
  original: QueryFn;
  wrapper: QueryFn;
  /** Whether `query` was an own property of this prototype before the wrap. */
  hadOwn: boolean;
}

/** On a wrapped prototype (own, non-enumerable): `{ original, wrapper, hadOwn }`. Shared across SDK copies. */
export const PG_QUERY_WRAP: unique symbol = Symbol.for('query-analyser.pg-query-wrap') as never;

/** On a wrapped Pool prototype (pg's BoundPool): the same record shape, under its own key. */
export const PG_POOL_QUERY_WRAP: unique symbol = Symbol.for('query-analyser.pg-pool-query-wrap') as never;

/** Wrappers created by this module copy. */
const ourWrappers = new WeakSet<QueryFn>();
/** Client prototypes whose wrapper is active (and which undoPgWraps visits). */
const wrapped = new Set<object>();
/** Pool prototypes whose wrapper is active. */
const wrappedPools = new Set<object>();

/**
 * The caller's frame, captured by the Pool wrapper and keyed by the config object pg-pool later
 * hands to `client.query` unchanged (pg-pool/index.js:467). Under contention pg-pool serves a
 * queued request from the releasing query's async context (it has no AsyncResource), so
 * `als.getStore()` at `Client.prototype.query` time would be the releaser's frame. The entry
 * records "no frame" too, so a frameless caller never inherits one, and is consumed on first read.
 */
const callerFrame = new WeakMap<object, { frame: unknown }>();

const hasOwn = (o: object, k: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v: unknown): v is object => (typeof v === 'object' || typeof v === 'function') && v !== null;

/** True for the call `@prisma/adapter-pg` makes: `rowMode: 'array'` and a `types` object with `getTypeParser` (Decision 5). */
export function isAdapterShape(config: unknown): boolean {
  try {
    if (!isObject(config)) return false;
    const c = config as { rowMode?: unknown; types?: unknown };
    if (c.rowMode !== 'array') return false;
    const types = c.types;
    return isObject(types) && typeof (types as { getTypeParser?: unknown }).getTypeParser === 'function';
  } catch {
    return false;
  }
}

function recordOf(proto: object, key: symbol = PG_QUERY_WRAP): PgWrapRecord | null {
  if (!hasOwn(proto, key)) return null;
  const r = (proto as Record<PropertyKey, unknown>)[key];
  return isObject(r) ? (r as PgWrapRecord) : null;
}

/** True when `fn` is an SDK wrapper: ours, or one recorded by any SDK copy on the prototype chain. */
function isSdkWrapper(proto: object, fn: unknown, key: symbol): boolean {
  if (ourWrappers.has(fn as QueryFn)) return true;
  for (let p: object | null = proto; p; p = Object.getPrototypeOf(p) as object | null) {
    if (recordOf(p, key)?.wrapper === fn) return true;
  }
  return false;
}

/* eslint-disable prefer-rest-params */
/**
 * A callback that records first, then calls the app's with the same `this` and every argument, and the
 * same `length`. Arities 0-3 (all real pg callbacks) are fixed-arity templates: a defineProperty per
 * query cost about 0.23 µs (final review). Only another arity pays for one.
 */
function wrapCallback(cb: Callback, done: (err: unknown) => void): Callback {
  switch (cb.length) {
    case 0: return function (this: unknown): unknown { done(arguments[0]); return cb.apply(this, arguments as unknown as unknown[]); } as Callback;
    case 1: return function (this: unknown, err: unknown): unknown { done(err); return cb.apply(this, arguments as unknown as unknown[]); } as Callback;
    case 2: return function (this: unknown, err: unknown, _res: unknown): unknown { done(err); return cb.apply(this, arguments as unknown as unknown[]); } as Callback;
    case 3: return function (this: unknown, err: unknown, _res: unknown, _x: unknown): unknown { done(err); return cb.apply(this, arguments as unknown as unknown[]); } as Callback;
    default: {
      const w = function (this: unknown, err?: unknown): unknown { done(err); return cb.apply(this, arguments as unknown as unknown[]); };
      Object.defineProperty(w, 'length', { value: cb.length, configurable: true });
      return w as Callback;
    }
  }
}
/* eslint-enable prefer-rest-params */

/** Which callback pg will use (utils.normalizeQueryConfig): the callback argument, else a function in `values`, else `config.callback`. */
type Form =
  | { kind: 'promise' }
  | { kind: 'arg'; index: 1 | 2; cb: Callback }
  | { kind: 'config'; cb: Callback };

interface Call {
  form: Form;
  /** Records the statement once; never throws. */
  done(err: unknown, failed?: boolean): void;
}

function claim(frame: SqlFrame): void {
  try {
    if (frame.kind === 'statement' && !frame.claimed) frame.claimed = true;
  } catch { /* a frozen or foreign frame: still recorded, just not claimed */ }
}

/** Decides whether to time this call; null means pass it through untouched. May throw (the caller guards it). */
function begin(proto: object, self: unknown, config: unknown, values: unknown, callback: unknown): Call | null {
  const rt: SqlRuntime = sqlRuntime();
  if (rt.sink == null || !wrapped.has(proto) || config == null) return null;
  if (typeof (config as { submit?: unknown }).submit === 'function') return null; // a submittable
  const text = typeof config === 'string' ? config : (config as { text?: unknown }).text;
  if (typeof text !== 'string') return null;

  let form: Form;
  if (callback) {
    if (typeof callback !== 'function') return null; // pg throws its own TypeError
    form = { kind: 'arg', index: 2, cb: callback as Callback };
  } else if (typeof values === 'function') {
    form = { kind: 'arg', index: 1, cb: values as Callback };
  } else {
    const own = isObject(config) ? (config as { callback?: unknown }).callback : undefined;
    if (own) {
      if (typeof own !== 'function') return null; // pg throws its own TypeError
      form = { kind: 'config', cb: own as Callback };
    } else {
      form = { kind: 'promise' };
    }
  }

  const db = isObject(self) ? (self as { database?: unknown }).database : undefined;
  const database = typeof db === 'string' ? db : null;
  let store: unknown;
  const stashed = isObject(config) ? callerFrame.get(config) : undefined;
  if (stashed !== undefined) {
    callerFrame.delete(config as object);
    store = stashed.frame;
  } else {
    store = rt.als.getStore();
  }
  const frame = isObject(store) ? (store as SqlFrame) : undefined;
  const adapterShape = frame === undefined && rt.prismaAdapterResolved && isAdapterShape(config);
  const start = performance.now();
  let settled = false;

  return {
    form,
    done(err: unknown, failed: boolean = err != null): void {
      try {
        if (settled) return; // pg calls back once; a config reused with our callback on it must not count twice
        settled = true;
        const durationMs = performance.now() - start;
        let labels: Labels | null = null;
        if (frame !== undefined) {
          claim(frame);
          labels = labelsOf(frame);
        } else if (adapterShape) {
          labels = { orm: 'prisma', model: null, operation: null };
        }
        const ev = { text, database, durationMs, failed, errorCode: failed ? sqlStateOf(err) : null, labels };
        const sink = rt.sink;
        // The claim and the timing above are synchronous (the claim must be in place before the
        // value reaches the adapter); the record itself waits a microtask, off the app's path.
        if (sink) queueMicrotask(() => { try { sink.record(ev); } catch { /* the sink reports its own failures */ } });
      } catch { /* never reaches the app */ }
    },
  };
}

/** The arguments pg receives for a callback form: the app's, with the callback swapped for a recording one. */
function argsFor(call: Call, args: IArguments): unknown[] {
  const out = Array.prototype.slice.call(args) as unknown[];
  const { form } = call;
  if (form.kind === 'arg') {
    out[form.index] = wrapCallback(form.cb, (e) => call.done(e));
  } else if (form.kind === 'config') {
    const callback = wrapCallback(form.cb, (e) => call.done(e));
    out[0] = Object.create(out[0] as object, { callback: { value: callback, writable: true, configurable: true, enumerable: true } }) as unknown;
  }
  return out;
}

/** `p.then(record-and-return, record-and-rethrow)`; `p` itself when it is not thenable or `then` fails. */
function observe(p: unknown, call: Call): unknown {
  try {
    if (!isObject(p)) return p;
    const then = (p as { then?: unknown }).then;
    if (typeof then !== 'function') return p;
    return (then as (this: unknown, ok: (v: unknown) => unknown, fail: (e: unknown) => never) => unknown).call(
      p,
      (v: unknown) => { call.done(null, false); return v; },
      (e: unknown) => { call.done(e, true); throw e; },
    );
  } catch {
    return p;
  }
}


/**
 * Wraps `Ctor.prototype.query` once (across SDK copies), as installConnectWrap does: the descriptor's
 * flags are kept and `hadOwn` recorded under `key`; a prototype that already has the record, or that
 * inherits an SDK wrapper, is not wrapped again (a buried wrapper of ours is switched back on).
 */
function installWrap(Ctor: unknown, key: symbol, active: Set<object>, make: (proto: object, orig: QueryFn) => QueryFn): boolean {
  try {
    if (typeof Ctor !== 'function') return false;
    const proto = (Ctor as { prototype?: unknown }).prototype;
    if (!isObject(proto)) return false;

    const existing = recordOf(proto, key);
    if (existing) {
      if (ourWrappers.has(existing.wrapper)) active.add(proto);
      return false;
    }

    const original = (proto as { query?: unknown }).query;
    if (typeof original !== 'function') return false;
    if (isSdkWrapper(proto, original, key)) return false;

    const ownDesc = Object.getOwnPropertyDescriptor(proto, 'query');
    const hadOwn = ownDesc !== undefined;
    const orig = original as QueryFn;
    const wrapper = make(proto, orig);
    ourWrappers.add(wrapper);

    Object.defineProperty(proto, 'query', {
      value: wrapper,
      writable: ownDesc?.writable ?? true,
      enumerable: ownDesc?.enumerable ?? false,
      configurable: ownDesc?.configurable ?? true,
    });
    const record: PgWrapRecord = { original: orig, wrapper, hadOwn };
    try {
      Object.defineProperty(proto, key, { value: record, enumerable: false, writable: false, configurable: true });
    } catch (e) {
      if (hadOwn) Object.defineProperty(proto, 'query', ownDesc);
      else delete (proto as { query?: unknown }).query;
      throw e;
    }
    active.add(proto);
    return true;
  } catch {
    return false;
  }
}

/** Wraps Client.prototype.query once (across SDK copies). True when newly wrapped now. Never throws. */
export function installPgWrap(Client: unknown): boolean {
  return installWrap(Client, PG_QUERY_WRAP, wrapped, (proto, orig) => function query(this: unknown, config?: unknown, values?: unknown, callback?: unknown): unknown {
    let call: Call | null = null;
    let args: unknown[] | null = null;
    try {
      call = begin(proto, this, config, values, callback);
      // The promise form changes no argument: no copy (final review).
      if (call !== null && call.form.kind !== 'promise') args = argsFor(call, arguments);
    } catch {
      call = null;
    }
    // A synchronous throw from pg propagates unchanged and records nothing.
    // eslint-disable-next-line prefer-rest-params
    if (call === null) return Reflect.apply(orig, this, arguments) as unknown;
    // eslint-disable-next-line prefer-rest-params
    if (args === null) return observe(Reflect.apply(orig, this, arguments) as unknown, call);
    return Reflect.apply(orig, this, args) as unknown;
  } as QueryFn);
}

/**
 * Wraps pg's Pool.prototype.query (pg-pool's, reached through pg's BoundPool) once. It only notes the
 * caller's frame for a config object, then calls the original with the same arguments; the Client
 * wrapper does the timing. True when newly wrapped now. Never throws.
 */
export function installPgPoolWrap(Pool: unknown): boolean {
  return installWrap(Pool, PG_POOL_QUERY_WRAP, wrappedPools, (proto, orig) => function query(this: unknown, config?: unknown): unknown {
    try {
      if (isObject(config) && wrappedPools.has(proto)) {
        const rt = sqlRuntime();
        if (rt.sink != null) callerFrame.set(config, { frame: rt.als.getStore() });
      }
    } catch { /* never reaches the app */ }
    // eslint-disable-next-line prefer-rest-params
    return Reflect.apply(orig, this, arguments) as unknown;
  } as QueryFn);
}

function undoWraps(key: symbol, active: Set<object>): void {
  for (const proto of active) {
    try {
      const record = recordOf(proto, key);
      if (!record) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, 'query');
      if (!desc || desc.value !== record.wrapper) continue; // another patch is on top: leave it (we are now inert)
      if (record.hadOwn) {
        Object.defineProperty(proto, 'query', { ...desc, value: record.original });
      } else {
        delete (proto as { query?: unknown }).query;
      }
      delete (proto as Record<PropertyKey, unknown>)[key];
    } catch { /* never throws */ }
  }
  active.clear();
}

/** For each Client and Pool prototype this copy wrapped: restore the original if the wrapper is still on top, else leave it as a pass-through. */
export function undoPgWraps(): void {
  undoWraps(PG_QUERY_WRAP, wrapped);
  undoWraps(PG_POOL_QUERY_WRAP, wrappedPools);
}
