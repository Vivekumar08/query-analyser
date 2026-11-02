import { sqlRuntime, labelsOf, type Labels, type OperationFrame, type SqlFrame, type StatementFrame, type SqlRuntime } from '../sql/context.js';
import { sqlStateOf } from '../sql/core.js';
import { pgClientClass } from '../drivers.js';
import { PG_QUERY_WRAP } from './pg.js';

/**
 * The Prisma tracing hook (spike Q2/Q3; Decisions 1, 2, 5, 12, 16).
 *
 * Prisma reads its tracing helper from `globalThis[KEY].helper` on every call. The SDK defines a
 * configurable accessor on each watched key:
 * - `V7_PRISMA_INSTRUMENTATION` (Prisma 7): with no app value, the SDK's own helper, which never
 *   hands out a sampled traceparent, so Prisma never changes the SQL because of the SDK;
 * - `V6_PRISMA_INSTRUMENTATION` and `PRISMA_INSTRUMENTATION` (5.22/6.x): only a helper the app
 *   installed (`@prisma/instrumentation`), wrapped and delegated to call for call.
 * The accessor sees every plain assignment the app makes; an app `delete` removes it, and
 * `ensurePrismaHook()` (every flush) re-defines it.
 *
 * Statements:
 * - JS `db_query` spans (Prisma 7): when the pg wrap covers the adapter's pg
 *   (`sqlRuntime().pgCoversPrismaAdapter`), pg counts them and this hook records none; it only
 *   sets operation frames so pg records carry the Prisma model and operation. Otherwise it records
 *   the ones no layer underneath claimed.
 * - Engine `db_query` spans (5.22/6.x): recorded unless they have a `js:query` child (the adapter
 *   ran them, so pg counted them), whatever the coverage flag says.
 * The V7 key yields the own helper only when no app helper is on V7 or on the unversioned key,
 * which Prisma 7 falls back to.
 *
 * Privacy: it reads only a span's name, ids, times and its SQL text attribute, and the
 * operation's `model` and `method`. Every SDK step is guarded; an app helper's own throw
 * propagates unchanged.
 */

export const PRISMA_HOOK: unique symbol = Symbol.for('query-analyser.prisma-hook') as never;
export const OWN_HELPER_KEY = 'V7_PRISMA_INSTRUMENTATION';
export const WATCHED_KEYS = ['V7_PRISMA_INSTRUMENTATION', 'V6_PRISMA_INSTRUMENTATION', 'PRISMA_INSTRUMENTATION'] as const;
/** An unsampled, invalid traceparent: Prisma treats it as "not sampled" and adds no SQL comment. */
export const DISABLED_TRACEPARENT = '00-10-10-00';

export interface EngineStatement { text: string; durationMs: number }

type WatchedKey = (typeof WATCHED_KEYS)[number];
type Fn = (this: unknown, ...args: unknown[]) => unknown;

/** The process-wide record on `globalThis[PRISMA_HOOK]`. `stored` holds the app's own value per key. */
interface HookRecord { owner: object; stored: Map<string, unknown> }

const isObject = (v: unknown): v is object => (typeof v === 'object' || typeof v === 'function') && v !== null;
const hasOwn = (o: object, k: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** `(end - start)` of two `[seconds, nanoseconds]` pairs in ms; null when malformed or negative. */
function hrDurationMs(start: unknown, end: unknown): number | null {
  if (!Array.isArray(start) || !Array.isArray(end)) return null;
  const [s0, s1] = start as unknown[];
  const [e0, e1] = end as unknown[];
  if (typeof s0 !== 'number' || typeof s1 !== 'number' || typeof e0 !== 'number' || typeof e1 !== 'number') return null;
  const ms = (e0 - s0) * 1e3 + (e1 - s1) / 1e6;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

const isStatementSpan = (name: unknown): boolean => typeof name === 'string' && name.endsWith('db_query');
const isJsQuerySpan = (name: unknown): boolean => typeof name === 'string' && name.includes('js:query');

/** `attributes[key]` when it is a string; never reads another attribute. */
function textAttr(attributes: unknown, key: string): string | null {
  if (!isObject(attributes)) return null;
  const t = (attributes as Record<string, unknown>)[key];
  return typeof t === 'string' ? t : null;
}

/** 6.1+: one dispatchEngineSpans batch → statements; skips db_query spans that have a js:query child in the batch. */
export function statementsFromBatch(spans: unknown): EngineStatement[] {
  const out: EngineStatement[] = [];
  try {
    if (!Array.isArray(spans)) return out;
    const list = spans as unknown[];
    const withJsChild = new Set<unknown>();
    for (const s of list) {
      try {
        if (isObject(s) && isJsQuerySpan((s as { name?: unknown }).name)) withJsChild.add((s as { parentId?: unknown }).parentId);
      } catch { /* malformed: skipped */ }
    }
    for (const s of list) {
      try {
        if (!isObject(s)) continue;
        const span = s as { id?: unknown; name?: unknown; startTime?: unknown; endTime?: unknown; attributes?: unknown };
        if (!isStatementSpan(span.name)) continue;
        const id = span.id;
        if (id != null && withJsChild.has(id)) continue; // the adapter ran it: pg counted it
        const text = textAttr(span.attributes, 'db.query.text');
        const durationMs = hrDurationMs(span.startTime, span.endTime);
        if (text !== null && durationMs !== null) out.push({ text, durationMs });
      } catch { /* malformed: skipped */ }
    }
  } catch { /* never throws */ }
  return out;
}

/**
 * 5.22/6.0: `createEngineSpan({ span: true, spans: [one span] })` events, children before parents.
 * A `js:query` child's parent id is remembered (FIFO of at most `maxIds`), and its `db_query`
 * parent is skipped when it arrives.
 */
export function createLegacySpanTracker(maxIds = 2_000): { observe(event: unknown): EngineStatement[]; size(): number } {
  const parents = new Set<string>();
  return {
    size: () => parents.size,
    observe(event: unknown): EngineStatement[] {
      const out: EngineStatement[] = [];
      try {
        if (!isObject(event)) return out;
        const spans = (event as { spans?: unknown }).spans;
        if (!Array.isArray(spans)) return out;
        for (const s of spans as unknown[]) {
          try {
            if (!isObject(s)) continue;
            const span = s as { span_id?: unknown; parent_span_id?: unknown; name?: unknown; start_time?: unknown; end_time?: unknown; attributes?: unknown };
            const name = span.name;
            if (isJsQuerySpan(name)) {
              const parent = span.parent_span_id;
              if (typeof parent !== 'string') continue;
              parents.delete(parent); // re-insert as newest
              parents.add(parent);
              while (parents.size > maxIds) {
                const oldest = parents.values().next();
                if (oldest.done === true) break;
                parents.delete(oldest.value);
              }
            } else if (isStatementSpan(name)) {
              const id = span.span_id;
              if (typeof id === 'string' && parents.delete(id)) continue; // pg counted it
              const text = textAttr(span.attributes, 'db.statement');
              const durationMs = hrDurationMs(span.start_time, span.end_time);
              if (text !== null && durationMs !== null) out.push({ text, durationMs });
            }
          } catch { /* malformed: skipped */ }
        }
      } catch { /* never throws */ }
      return out;
    },
  };
}

/**
 * True when `@prisma/adapter-pg` resolved and its pg's `Client.prototype` carries the pg wrap
 * record as an own property, i.e. the pg layer counts every adapter statement (Task 5 ruling).
 * `adapterPg` is the pg module (or Client class) required from the adapter's entry. Pure.
 */
export function pgCoversAdapter(adapterResolved: boolean, adapterPg: unknown): boolean {
  try {
    if (adapterResolved !== true) return false;
    const Client = pgClientClass(adapterPg) ?? (typeof adapterPg === 'function' ? adapterPg : null);
    const proto = Client === null ? undefined : (Client as { prototype?: unknown }).prototype;
    return isObject(proto) && hasOwn(proto, PG_QUERY_WRAP) && isObject((proto as Record<PropertyKey, unknown>)[PG_QUERY_WRAP]);
  } catch {
    return false;
  }
}

const ENGINE_LABELS: Labels = { orm: 'prisma', model: null, operation: null };

/** Hands one statement to the sink; never throws (the sink reports its own failures). */
function emit(rt: SqlRuntime, text: string, durationMs: number, failed: boolean, errorCode: string | null, labels: Labels | null): void {
  try {
    const sink = rt.sink;
    if (!sink) return;
    const ev = { text, database: null, durationMs, failed, errorCode, labels };
    // As in pg.ts: the record waits a microtask, off the app's path.
    queueMicrotask(() => { try { sink.record(ev); } catch { /* the sink reports its own failures */ } });
  } catch { /* never reaches the app */ }
}

/**
 * The pg layer counts every JS `db_query` statement: the helper records none of them (Task 5
 * ruling). Engine spans are not gated by this: pg never sees an engine statement, and the
 * per-span `js:query`-child rule already skips the ones the adapter ran (Decision 5, spike Q3).
 */
const pgCounts = (rt: SqlRuntime): boolean => rt.pgCoversPrismaAdapter === true;

/** Engine statements carry no SQLSTATE: never failed, no code (Decision 12). */
function emitEngine(rt: SqlRuntime, statements: EngineStatement[], labels: Labels | null): void {
  for (const s of statements) emit(rt, s.text, s.durationMs, false, null, labels);
}

/** The frame to enter for one span, or null to run the callback untouched. Never throws. */
interface Plan { rt: SqlRuntime; frame: SqlFrame; text: string | null }

function planFor(nameOrOptions: unknown): Plan | null {
  try {
    const rt = sqlRuntime();
    if (rt.sink == null) return null;
    let name: unknown;
    let attributes: unknown;
    if (typeof nameOrOptions === 'string') {
      name = nameOrOptions;
    } else if (isObject(nameOrOptions)) {
      name = (nameOrOptions as { name?: unknown }).name;
      attributes = (nameOrOptions as { attributes?: unknown }).attributes;
    }
    if (name === 'operation') {
      if (!isObject(attributes)) return null;
      const { model, method } = attributes as { model?: unknown; method?: unknown };
      if (typeof method !== 'string') return null;
      const frame: OperationFrame = { kind: 'operation', model: typeof model === 'string' ? model : null, operation: method };
      return { rt, frame, text: null };
    }
    if (name === 'db_query') {
      const store: unknown = rt.als.getStore();
      let op: OperationFrame | null = null;
      if (isObject(store)) {
        const f = store as SqlFrame;
        op = f.kind === 'operation' ? f : f.kind === 'statement' ? (f.op ?? null) : null;
      }
      const frame: StatementFrame = { kind: 'statement', op, claimed: false };
      return { rt, frame, text: textAttr(attributes, 'db.query.text') };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Runs `run` in the plan's frame. For a statement, times it and, once it settles, records it
 * unless a layer underneath claimed it or pg counts Prisma statements. Returns exactly what
 * `run` returns (a thenable as `r.then(record-and-return, record-and-rethrow)`) or throws.
 */
function runIn(plan: Plan, run: () => unknown): unknown {
  const { rt, frame, text } = plan;
  if (frame.kind === 'operation') return rt.als.run(frame, run);
  const start = performance.now();
  let settled = false;
  const settle = (err: unknown, failed: boolean): void => {
    try {
      if (settled) return;
      settled = true;
      if (text === null || frame.claimed || pgCounts(rt)) return;
      emit(rt, text, performance.now() - start, failed, failed ? sqlStateOf(err) : null, labelsOf(frame));
    } catch { /* never reaches the app */ }
  };
  let r: unknown;
  try {
    r = rt.als.run(frame, run);
  } catch (e) {
    settle(e, true);
    throw e;
  }
  let then: unknown;
  try {
    then = isObject(r) ? (r as { then?: unknown }).then : undefined;
  } catch {
    then = undefined;
  }
  if (typeof then !== 'function') {
    settle(null, false);
    return r;
  }
  try {
    return (then as (this: unknown, ok: (v: unknown) => unknown, fail: (e: unknown) => never) => unknown).call(
      r,
      (v: unknown) => { settle(null, false); return v; },
      (e: unknown) => { settle(e, true); throw e; },
    );
  } catch {
    settle(null, false); // a thenable whose `then` throws: hand back what the callback returned
    return r;
  }
}

/** The SDK's own helper for `V7_PRISMA_INSTRUMENTATION`: enabled, never sampled, frames only. */
export function createOwnHelper(): object {
  return {
    isEnabled: (): boolean => true,
    getTraceParent: (): string => DISABLED_TRACEPARENT,
    dispatchEngineSpans: (): undefined => undefined,
    getActiveContext: (): undefined => undefined,
    runInChildSpan(nameOrOptions: unknown, cb: () => unknown): unknown {
      const plan = planFor(nameOrOptions);
      if (plan === null) return cb();
      return runIn(plan, cb);
    },
  };
}

/** Wraps the app's helper object (`stored.helper`): frames and records, then delegates call for call. */
export function wrapAppHelper(app: object): object {
  const tracker = createLegacySpanTracker();
  const target = app as Record<PropertyKey, unknown>;
  const call = (name: string, args: unknown[]): unknown => Reflect.apply(target[name] as Fn, app, args);

  const intercepted: Record<string, Fn> = {
    runInChildSpan(nameOrOptions: unknown, cb: unknown, ...rest: unknown[]): unknown {
      let passed = cb;
      try {
        const plan = typeof cb === 'function' ? planFor(nameOrOptions) : null;
        if (plan !== null) {
          passed = function (this: unknown, ...a: unknown[]): unknown {
            return runIn(plan, () => (cb as Fn).apply(this, a));
          };
        }
      } catch { passed = cb; }
      return call('runInChildSpan', [nameOrOptions, passed, ...rest]);
    },
    dispatchEngineSpans(spans: unknown, ...rest: unknown[]): unknown {
      try {
        const rt = sqlRuntime();
        if (rt.sink != null) {
          const store: unknown = rt.als.getStore();
          emitEngine(rt, statementsFromBatch(spans), labelsOf(isObject(store) ? (store as SqlFrame) : undefined));
        }
      } catch { /* never reaches the app */ }
      return call('dispatchEngineSpans', [spans, ...rest]);
    },
    createEngineSpan(event: unknown, ...rest: unknown[]): unknown {
      try {
        const rt = sqlRuntime();
        if (rt.sink != null) emitEngine(rt, tracker.observe(event), ENGINE_LABELS);
      } catch { /* never reaches the app */ }
      return call('createEngineSpan', [event, ...rest]);
    },
  };

  const bound = new WeakMap<Fn, Fn>();
  return new Proxy(app, {
    get(t: object, prop: PropertyKey): unknown {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== 'function') return v;
      try {
        const d = Object.getOwnPropertyDescriptor(t, prop);
        if (d && d.configurable === false && d.writable === false) return v; // Proxy invariant
        if (typeof prop === 'string' && hasOwn(intercepted, prop)) return intercepted[prop];
        let b = bound.get(v as Fn);
        if (b === undefined) {
          const fn = v as Fn;
          b = function (this: unknown, ...a: unknown[]): unknown { return Reflect.apply(fn, t, a); };
          bound.set(fn, b);
        }
        return b;
      } catch {
        return v;
      }
    },
  });
}

/** This module copy's identity in `HookRecord.owner`. */
const owner: object = {};
/** The getters this copy defined, per key, to recognise its own accessors. */
const getters = new Map<string, () => unknown>();
/** Per app-stored `{ helper }` object: the wrapped holder handed to Prisma (re-made when `.helper` changes). */
const holders = new WeakMap<object, { helper: object; holder: object }>();
/** `{ helper: ownHelper }` for OWN_HELPER_KEY, made once per install. */
let ownHolder: { helper: object } | null = null;

function hookRecord(): HookRecord | undefined {
  try {
    const r = (globalThis as unknown as Record<symbol, unknown>)[PRISMA_HOOK];
    return isObject(r) ? (r as HookRecord) : undefined;
  } catch {
    return undefined;
  }
}

function storedValues(r: HookRecord | undefined): unknown[] {
  const g = globalThis as unknown as Record<string, unknown>;
  const stored = r?.stored;
  if (stored !== undefined && typeof stored.get === 'function') return WATCHED_KEYS.map((k) => stored.get(k));
  return WATCHED_KEYS.map((k) => g[k]);
}

const hasAppHelper = (v: unknown): boolean => isObject(v) && isObject((v as { helper?: unknown }).helper);

/** What Prisma reads from `globalThis[key]`. */
function valueFor(key: WatchedKey, stored: Map<string, unknown>): unknown {
  let value: unknown;
  try {
    value = stored.get(key);
  } catch {
    return undefined;
  }
  try {
    if (sqlRuntime().sink == null) return value;
    if (value == null) {
      if (key !== OWN_HELPER_KEY) return value;
      // Prisma 7 reads `V7?.helper ?? PRISMA_INSTRUMENTATION?.helper`. An app helper on the
      // unversioned key must not be hidden by ours: answer undefined, so Prisma falls back to it
      // (already wrapped by that key's getter), exactly as it would without the SDK.
      if (hasAppHelper(stored.get('PRISMA_INSTRUMENTATION'))) return undefined;
      ownHolder ??= { helper: createOwnHelper() };
      return ownHolder;
    }
    if (!isObject(value)) return value;
    const helper = (value as { helper?: unknown }).helper;
    if (!isObject(helper)) return value;
    const cached = holders.get(value);
    if (cached !== undefined && cached.helper === helper) return cached.holder;
    const holder = { ...value, helper: wrapAppHelper(helper) };
    holders.set(value, { helper, holder });
    return holder;
  } catch {
    return value;
  }
}

/** Defines our accessor on `key`, adopting the value already there as the app's. Never throws. */
function defineAccessor(key: WatchedKey, stored: Map<string, unknown>): void {
  try {
    const desc = Object.getOwnPropertyDescriptor(globalThis, key);
    if (desc !== undefined && desc.configurable === false) return;
    const current = desc === undefined ? undefined : (globalThis as unknown as Record<string, unknown>)[key];
    if (current !== undefined) stored.set(key, current);
    else stored.delete(key);
    const get = (): unknown => valueFor(key, stored);
    const set = (v: unknown): void => {
      try { stored.set(key, v); } catch { /* never reaches the app */ }
    };
    Object.defineProperty(globalThis, key, { get, set, configurable: true, enumerable: false });
    getters.set(key, get);
  } catch { /* leave this key alone */ }
}

const isOurs = (key: string): boolean => {
  const d = Object.getOwnPropertyDescriptor(globalThis, key);
  return d !== undefined && d.get !== undefined && d.get === getters.get(key);
};

/** Defines a configurable accessor on each watched key (once per process). True when installed now. */
export function installPrismaHook(): boolean {
  try {
    if (hookRecord() !== undefined) return false; // this or another SDK copy already owns it
    const record: HookRecord = { owner, stored: new Map<string, unknown>() };
    Object.defineProperty(globalThis, PRISMA_HOOK, { value: record, enumerable: false, writable: false, configurable: true });
    ownHolder = null;
    for (const key of WATCHED_KEYS) defineAccessor(key, record.stored);
    return true;
  } catch {
    return false;
  }
}

/** Re-defines any watched accessor an app deleted (or replaced with a data property), or installs the hook when no copy owns it. Called on every flush. */
export function ensurePrismaHook(): void {
  try {
    const r = hookRecord();
    if (r === undefined) {
      installPrismaHook(); // the owning copy shut down while this copy's sink is live
      return;
    }
    if (r.owner !== owner) return;
    for (const key of WATCHED_KEYS) {
      if (!isOurs(key)) defineAccessor(key, r.stored);
    }
  } catch { /* never throws */ }
}

/** Each watched key becomes a plain data property again, holding the app's own stored { helper } object, or is deleted when there is none. */
export function undoPrismaHook(): void {
  try {
    const r = hookRecord();
    if (r === undefined || r.owner !== owner) return;
    for (const key of WATCHED_KEYS) {
      try {
        if (!isOurs(key)) continue; // the app replaced or deleted it: leave its choice
        const v = r.stored.get(key);
        if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, writable: true, enumerable: true, configurable: true });
        else delete (globalThis as unknown as Record<string, unknown>)[key];
      } catch { /* next key */ }
    }
    delete (globalThis as unknown as Record<symbol, unknown>)[PRISMA_HOOK];
    getters.clear();
    ownHolder = null;
  } catch { /* never throws */ }
}

/** True when an app helper is present on any watched key. */
export function appHelperPresent(): boolean {
  try {
    return storedValues(hookRecord()).some(hasAppHelper);
  } catch {
    return false;
  }
}
