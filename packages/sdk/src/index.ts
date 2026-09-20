import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { bucketOf } from '@query-analyser/contract/runtime';
import type { IngestPayload } from '@query-analyser/contract/runtime';
import { Aggregator } from './aggregator.js';
import { installHooks, type MongooseSchemaLike, type HookContext } from './hooks.js';
import { createTransport } from './transport.js';

export const SDK_VERSION = '0.1.0';
const DEFAULT_ENDPOINT = 'https://ingest.query-analyser.dev/v1/ingest';

export interface MongooseLike {
  plugin(fn: (schema: MongooseSchemaLike) => void): unknown;
  models: Record<string, { schema: MongooseSchemaLike; _applyQueryMiddleware?: () => void }>;
}

// Structural shape of the internal bits of a compiled mongoose Model/Schema
// that `reapplyPreCompiledHooks` below needs to touch. Not part of the
// public MongooseLike surface — reached into only for models that existed
// before init() ran, and guarded with `typeof === 'function'`/optional
// chaining everywhere so an unexpected mongoose internals shape degrades to
// "leave this model alone" instead of throwing.
type PreCompiledModel = {
  schema: MongooseSchemaLike & { s?: { hooks?: { clone?: () => unknown } } };
  _applyQueryMiddleware?: () => void;
  hooks?: unknown;
};

/**
 * Bug found by the real-mongoose integration test: mongoose takes TWO
 * separate snapshots of a schema's middleware at Model.compile() time, and
 * neither updates on its own once new hooks are added to the schema
 * afterwards (which is exactly what installHooks() does for a model that
 * was compiled before init() ran):
 *
 *  - `Model._applyQueryMiddleware()` filters `schema.s.hooks` into
 *    `Query.prototype._queryMiddleware`, read by find/update/delete/etc.
 *  - `model.hooks = schema.s.hooks.clone()` is a separate clone read by
 *    `Model.aggregate()`.
 *
 * Both are re-derivable from the schema's live hook list after the fact —
 * confirmed with a bare mongoose repro for each — so both are rebuilt here
 * immediately after installHooks() mutates the schema of an
 * already-compiled model.
 */
function reapplyPreCompiledHooks(model: PreCompiledModel): void {
  model._applyQueryMiddleware?.();
  const clone = model.schema.s?.hooks?.clone;
  if (typeof clone === 'function') {
    model.hooks = clone.call(model.schema.s!.hooks);
  }
}

export interface InitOptions {
  apiKey: string;
  app: string;
  endpoint?: string;
  env?: string;
  thresholdMs?: number;
  flushIntervalMs?: number;
  maxSignatures?: number;
  enabled?: boolean;
  mongoose?: MongooseLike;
  fetchImpl?: typeof fetch;
  onError?: (e: Error) => void;
}

export interface Analyser {
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly installedModels: number;
}

/**
 * Test-only extension of Analyser. `_aggregator` lets tests seed content
 * into the aggregator directly (there is no live mongoose connection in
 * these unit tests to produce real queries) without adding anything to the
 * public Analyser surface.
 */
type InternalAnalyser = Analyser & { _stop(): void; _aggregator: Aggregator };

let active: InternalAnalyser | null = null;
let activeOptions: { apiKey: string; app: string } | null = null;

// Bug found by the real-mongoose integration test: `mg.plugin(fn)` registers
// `fn` on mongoose PERMANENTLY — mongoose has no way to unregister a global
// plugin. The original code called `mg.plugin((schema) => installHooks(schema,
// ctx))` fresh inside every init() call, closing over that call's `ctx`. In a
// test suite (or any process that calls shutdown() then init() again — a
// config reload, a hot-reloaded dev server) this means every `init()` call
// after the first adds ANOTHER permanent plugin, all still registered. When a
// later model compiles, mongoose runs every registered plugin against its
// schema in registration order; `installHooks` short-circuits on the
// `INSTALLED` schema symbol, so only the FIRST-ever-registered plugin's
// closure — bound to the FIRST init() call's (long-dead) aggregator and
// transport — ever actually attaches hooks. Every query on every model
// created after the first `init()` call silently reported to a discarded
// analyser instead of the current one, so subsequent flush() calls saw
// nothing. Confirmed with a bare mongoose repro: a second `mongoose.plugin()`
// call never fires its callback for a schema an earlier-registered plugin
// already marked installed.
//
// Fix: register the mongoose-level plugin function exactly ONCE per mongoose
// instance (marked with a symbol, mirroring the per-schema INSTALLED guard),
// and have that single, permanent plugin dispatch to whichever ctx is
// "current" at the moment a schema is compiled, via a mutable holder that
// each init() call overwrites. Models compiled while no analyser is active
// (holder empty) are simply left uninstrumented, same as before.
const CURRENT_CTX = Symbol.for('query-analyser.current-ctx');
const PLUGIN_REGISTERED = Symbol.for('query-analyser.plugin-registered');

type MongooseWithState = MongooseLike & {
  [CURRENT_CTX]?: HookContext;
  [PLUGIN_REGISTERED]?: boolean;
};

// Controller Ruling A: the brief's original body referenced module.require,
// which is undefined in the ESM build Task 10's bundler emits — silent
// failure for every ESM consumer. createRequire(process.cwd() + '/')
// resolves mongoose from the host application's working directory, where the
// host's node_modules lives, and works identically under both CJS and ESM
// builds (unlike import.meta.url, which is undefined under the CJS build).
function resolveMongoose(explicit?: MongooseLike): MongooseLike | null {
  if (explicit) return explicit;
  try {
    const req = createRequire(process.cwd() + '/');
    return req('mongoose') as MongooseLike;
  } catch {
    return null;
  }
}

export function init(options: InitOptions): Analyser {
  const onError = options.onError
    ?? ((e: Error) => process.stderr.write(`[query-analyser] ${e.message}\n`));

  // Minor fix: check for an existing instance before validating options, so
  // a second init() call — even one with a bad/omitted apiKey — returns the
  // live instance instead of throwing. If the new call's identity differs
  // from the one already active, warn instead of silently reusing the wrong
  // key/app — that mismatch would otherwise be a silent support ticket.
  if (active) {
    if (activeOptions && (activeOptions.apiKey !== options.apiKey || activeOptions.app !== options.app)) {
      onError(new Error(
        'query-analyser: init() was already called with different options; reusing the existing instance and ignoring the apiKey/app from this call',
      ));
    }
    return active;
  }

  if (!options.apiKey) throw new Error('query-analyser: apiKey is required');
  if (!options.app) throw new Error('query-analyser: app is required');

  if (options.enabled === false) {
    const noop: InternalAnalyser = {
      flush: async () => {}, shutdown: async () => {}, installedModels: 0, _stop: () => {},
      _aggregator: new Aggregator(options.maxSignatures ?? 5000),
    };
    active = noop;
    activeOptions = { apiKey: options.apiKey, app: options.app };
    return noop;
  }

  const thresholdMs = options.thresholdMs ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 10_000;
  const aggregator = new Aggregator(options.maxSignatures ?? 5000);
  const transport = createTransport({
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    onError,
  });

  let disabled = false;
  const ctx = { aggregator, thresholdMs, onError, isDisabled: () => disabled };
  let installedModels = 0;
  let backoffUntil = 0;
  // Fix round 2: was a boolean `flushing` guard. That made a timer-driven
  // flush and a shutdown()-driven flush mutually exclusive but not joined —
  // shutdown() could resolve while the real network call from an in-flight
  // flush was still pending, dropping the last window on process.exit().
  // Tracking the in-flight promise lets every caller (timer, shutdown, a
  // customer's own flush()) await the SAME send instead of one bailing out.
  let inFlight: Promise<void> | null = null;

  const mg = resolveMongoose(options.mongoose);
  if (!mg) {
    onError(new Error('mongoose could not be resolved — pass it as init({ mongoose })'));
  } else {
    const mgState = mg as MongooseWithState;
    // This init() call is now "current" for any model compiled from here on.
    mgState[CURRENT_CTX] = ctx;
    // Future models — register the plugin function itself only once ever
    // for this mongoose instance; see the CURRENT_CTX comment above for why.
    if (!mgState[PLUGIN_REGISTERED]) {
      mgState[PLUGIN_REGISTERED] = true;
      mg.plugin((schema) => {
        const liveCtx = mgState[CURRENT_CTX];
        if (liveCtx) installHooks(schema, liveCtx);
      });
    }
    // Models already compiled before init ran — without this, setup is
    // order-dependent and the one-line promise is false. See
    // reapplyPreCompiledHooks() above for why installHooks() alone is not
    // enough for a model that already existed.
    for (const name of Object.keys(mg.models)) {
      const model = mg.models[name]! as unknown as PreCompiledModel;
      if (installHooks(model.schema, ctx)) {
        installedModels++;
        reapplyPreCompiledHooks(model);
      }
    }
  }

  const doFlush = async (): Promise<void> => {
    // Fix round 3: transport.send() never rejects, but swap()/bucketOf()/
    // hostname() — or a future edit — theoretically could. flush() is
    // called fire-and-forget (`void flush()`) from the interval tick and
    // beforeExit, so an unhandled rejection here would, by default since
    // Node 15, crash the host process. The SDK's contract is that it never
    // takes the host down, so every failure must resolve, not reject.
    try {
      const { items, dropped } = aggregator.swap();
      if (items.length === 0 && dropped === 0) return;

      const payload: IngestPayload = {
        app: options.app,
        env: options.env ?? process.env.NODE_ENV ?? 'development',
        host: hostname(),
        sdkVersion: SDK_VERSION,
        bucket: bucketOf(new Date()),
        thresholdMs,
        dropped,
        items,
      };

      const result = await transport.send(payload);
      if (result.status === 'retry') {
        backoffUntil = Date.now() + result.afterMs;
        aggregator.merge(items);
      } else if (result.status === 'disabled') {
        disabled = true;
        onError(new Error(result.reason));
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // setInterval doesn't await flush(), so a send() slower than
  // flushIntervalMs could otherwise let two flushes overlap, each swap()ing
  // the buffer concurrently. A single shared in-flight promise means a
  // second caller (the timer, shutdown(), or a customer calling flush()
  // directly) joins the same send instead of racing it or silently no-oping.
  const flush = (): Promise<void> => {
    if (disabled || Date.now() < backoffUntil) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = doFlush().finally(() => { inFlight = null; });
    return inFlight;
  };

  const timer = setInterval(() => { void flush(); }, flushIntervalMs);
  timer.unref();

  // Critical fix: do NOT install a SIGTERM listener. process.once('SIGTERM',
  // ...) with a handler that never calls process.exit() removes Node's
  // default terminate-on-SIGTERM behavior, so a host app with an open HTTP
  // server or DB pool would no longer exit on SIGTERM at all — k8s/systemd
  // would wait out the grace period and SIGKILL it. beforeExit is safe to
  // keep: it only fires once the event loop is already draining on its own.
  const onExit = () => { void flush(); };
  process.once('beforeExit', onExit);

  const analyser: InternalAnalyser = {
    flush,
    installedModels,
    async shutdown() {
      clearInterval(timer);
      process.off('beforeExit', onExit);
      // Fix round 2: the first await joins whatever flush is already in
      // flight (started by the timer or a caller) rather than racing past
      // it — shutdown() must not resolve while a real send is still
      // pending, or a customer doing `await shutdown(); process.exit(0)`
      // would exit mid-send and drop the last window. The second await
      // drains anything that arrived (via the post hook, or a test seam)
      // while that first flush was in flight, since swap() only takes what
      // existed at the moment it ran. backoffUntil is reset before each
      // await so a retry() from either flush doesn't suppress the drain.
      backoffUntil = 0;
      await flush();
      backoffUntil = 0;
      await flush();
      // Stop instrumenting any model compiled after shutdown — the plugin
      // function itself stays registered forever (mongoose can't unregister
      // it), but it becomes a no-op once nothing is "current". Guarded so a
      // shutdown() racing a newer init() never clobbers the newer ctx.
      if (mg && (mg as MongooseWithState)[CURRENT_CTX] === ctx) {
        delete (mg as MongooseWithState)[CURRENT_CTX];
      }
    },
    _stop() { clearInterval(timer); },
    _aggregator: aggregator,
  };

  active = analyser;
  activeOptions = { apiKey: options.apiKey, app: options.app };
  return analyser;
}

export async function shutdown(): Promise<void> {
  const a = active;
  active = null;
  activeOptions = null;
  await a?.shutdown();
}

export { Aggregator } from './aggregator.js';
export { buildSignature } from './signature.js';
export { redact } from './redact.js';
export default { init, shutdown };
