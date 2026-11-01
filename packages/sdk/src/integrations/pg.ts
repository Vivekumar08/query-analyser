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

/** Wrappers created by this module copy. */
const ourWrappers = new WeakSet<QueryFn>();
/** Prototypes whose wrapper is active (and which undoPgWraps visits). */
const wrapped = new Set<object>();

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

function recordOf(proto: object): PgWrapRecord | null {
  if (!hasOwn(proto, PG_QUERY_WRAP)) return null;
  const r = (proto as Record<PropertyKey, unknown>)[PG_QUERY_WRAP];
  return isObject(r) ? (r as PgWrapRecord) : null;
}

/** True when `fn` is an SDK wrapper: ours, or one recorded by any SDK copy on the prototype chain. */
function isSdkWrapper(proto: object, fn: unknown): boolean {
  if (ourWrappers.has(fn as QueryFn)) return true;
  for (let p: object | null = proto; p; p = Object.getPrototypeOf(p) as object | null) {
    if (recordOf(p)?.wrapper === fn) return true;
  }
  return false;
}

/** A callback that records first, then calls the app's with the same `this` and arguments; same `length` and `name`. */
function wrapCallback(cb: Callback, done: (err: unknown) => void): Callback {
  const w = function (this: unknown, err?: unknown): unknown {
    done(err);
    // eslint-disable-next-line prefer-rest-params
    return cb.apply(this, arguments as unknown as unknown[]);
  };
  Object.defineProperty(w, 'length', { value: cb.length, configurable: true });
  try { Object.defineProperty(w, 'name', { value: cb.name, configurable: true }); } catch { /* keep 'w' */ }
  return w;
}

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
  const store: unknown = rt.als.getStore();
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
        rt.sink?.record({ text, database, durationMs, failed, errorCode: failed ? sqlStateOf(err) : null, labels });
      } catch { /* never reaches the app; the sink reports its own failures */ }
    },
  };
}

/** The arguments pg receives: the app's, with the callback swapped for a recording one. */
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

/** Wraps Client.prototype.query once (across SDK copies). True when newly wrapped now. Never throws. */
export function installPgWrap(Client: unknown): boolean {
  try {
    if (typeof Client !== 'function') return false;
    const proto = (Client as { prototype?: unknown }).prototype;
    if (!isObject(proto)) return false;

    const existing = recordOf(proto);
    if (existing) {
      // Already wrapped. If the wrapper is ours and was buried under another
      // library's patch by an earlier undo, switch it back on rather than
      // stacking a second one.
      if (ourWrappers.has(existing.wrapper)) wrapped.add(proto);
      return false;
    }

    const original = (proto as { query?: unknown }).query;
    if (typeof original !== 'function') return false;
    // Inherits a query an SDK copy already wrapped (a subclass of a wrapped client).
    if (isSdkWrapper(proto, original)) return false;

    const ownDesc = Object.getOwnPropertyDescriptor(proto, 'query');
    const hadOwn = ownDesc !== undefined;
    const orig = original as QueryFn;

    const wrapper = function query(this: unknown, config?: unknown, values?: unknown, callback?: unknown): unknown {
      let call: Call | null = null;
      let args: unknown[] | null = null;
      try {
        call = begin(proto, this, config, values, callback);
        if (call !== null) args = argsFor(call, arguments);
      } catch {
        call = null;
      }
      // eslint-disable-next-line prefer-rest-params
      if (call === null || args === null) return Reflect.apply(orig, this, arguments) as unknown;
      // A synchronous throw from pg propagates unchanged and records nothing.
      const result = Reflect.apply(orig, this, args) as unknown;
      return call.form.kind === 'promise' ? observe(result, call) : result;
    } as QueryFn;
    ourWrappers.add(wrapper);

    Object.defineProperty(proto, 'query', {
      value: wrapper,
      writable: ownDesc?.writable ?? true,
      enumerable: ownDesc?.enumerable ?? false,
      configurable: ownDesc?.configurable ?? true,
    });
    const record: PgWrapRecord = { original: orig, wrapper, hadOwn };
    try {
      Object.defineProperty(proto, PG_QUERY_WRAP, { value: record, enumerable: false, writable: false, configurable: true });
    } catch (e) {
      if (hadOwn) Object.defineProperty(proto, 'query', ownDesc);
      else delete (proto as { query?: unknown }).query;
      throw e;
    }
    wrapped.add(proto);
    return true;
  } catch {
    return false;
  }
}

/** For each prototype this copy wrapped: restore the original if the wrapper is still on top, else leave it as a pass-through. */
export function undoPgWraps(): void {
  for (const proto of wrapped) {
    try {
      const record = recordOf(proto);
      if (!record) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, 'query');
      if (!desc || desc.value !== record.wrapper) continue; // another patch is on top: leave it (we are now inert)
      if (record.hadOwn) {
        Object.defineProperty(proto, 'query', { ...desc, value: record.original });
      } else {
        delete (proto as { query?: unknown }).query;
      }
      delete (proto as Record<PropertyKey, unknown>)[PG_QUERY_WRAP];
    } catch { /* never throws */ }
  }
  wrapped.clear();
}
