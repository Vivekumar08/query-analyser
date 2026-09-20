import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { bucketOf } from '@query-analyser/contract/runtime';
import type { IngestPayload } from './types.js';
import { Aggregator } from './aggregator.js';
import { installHooks, INSTALLED, type MongooseSchemaLike, type HookContext, type GetHookContext } from './hooks.js';
import { createTransport } from './transport.js';

// Minor fix 7: hand-typed and previously could drift from package.json.
// `__SDK_VERSION__` is a build-time constant substituted both by tsup's
// `define` (see tsup.config.ts) and by vitest's `define` (see
// vitest.config.ts), each sourced from package.json's own `version` field —
// so the published dist and the test run both see the real value and the
// two cannot diverge silently.
declare const __SDK_VERSION__: string;
export const SDK_VERSION: string = typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : '0.0.0';
const DEFAULT_ENDPOINT = 'https://ingest.query-analyser.dev/v1/ingest';
// Critical 2: mirrors `items.max(5000)` in @query-analyser/contract's
// ingestPayloadSchema. Duplicated as a literal (not imported) because the
// contract package is dev-only for the SDK — see types.ts for why the SDK
// never imports runtime values from it.
const MAX_SIGNATURES = 5000;

function resolveMaxSignatures(requested: number | undefined, onError: (e: Error) => void): number {
  const value = requested ?? MAX_SIGNATURES;
  if (value > MAX_SIGNATURES) {
    onError(new Error(
      `query-analyser: maxSignatures (${value}) exceeds the ingest API's limit of ${MAX_SIGNATURES}; clamping to ${MAX_SIGNATURES}`,
    ));
    return MAX_SIGNATURES;
  }
  return value;
}

interface MongooseLike {
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
 *
 * Fix round 1, Important 3 (controller ruling): this depends on two pieces
 * of undocumented mongoose internals — `schema.s.hooks` (a kareem instance,
 * with a `.clone()` method) and `Model._applyQueryMiddleware` — whose shape
 * has moved across major mongoose versions and is only verified here against
 * 8.24.4. Every access below is guarded (`typeof === 'function'` /  optional
 * chaining); if a future mongoose major changes this shape, the guards fail
 * closed — the model is silently left uninstrumented rather than throwing.
 * `peerDependencies.mongoose` in package.json is pinned to `>=8 <9`
 * accordingly; do not widen it without re-verifying this function against
 * the new major.
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

// Important 3: calling the returned `analyser.shutdown()` directly — the
// natural call for a TS user holding an `Analyser` — used to never clear
// module-level `active`/`activeOptions`. A later `init()` would then see
// `active` still set and hand back the SAME dead instance (timer cleared,
// context deleted, `installedModels: 0`), silently disabling instrumentation
// for the rest of the process's life. Both the instance method and the
// module-level `shutdown()` now route through this one function, guarded by
// identity so a shutdown() from a stale instance can never clobber a newer
// `init()` that has since replaced it.
function clearActiveIfSelf(self: InternalAnalyser): void {
  if (active === self) {
    active = null;
    activeOptions = null;
  }
}

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
// failure for every ESM consumer.
//
// Fix round 4, Important 4: `createRequire(process.cwd() + '/')` resolves
// mongoose relative to the process's CURRENT WORKING DIRECTORY, not the
// host application's install location. Those differ under a systemd unit
// with `WorkingDirectory=/`, under pm2, or when a monorepo is run from its
// root — and worse, cwd resolution can silently find a DIFFERENT copy of
// mongoose than the one the host actually requires elsewhere in its code
// (e.g. a stray top-level mongoose in a monorepo root's node_modules), in
// which case hooks get installed on schemas nobody queries through. Module-
// relative resolution (from this file's own location, walking up through
// node_modules the way Node normally resolves a peer dependency) finds the
// SAME copy of mongoose the host's own `require('mongoose')`/`import
// mongoose` would, regardless of cwd. cwd resolution is kept only as a
// fallback for the unusual case where mongoose is not reachable from this
// module's own resolution path.
function resolveMongoose(explicit?: MongooseLike): MongooseLike | null {
  if (explicit) return explicit;

  // Module-relative first. `import.meta.url` is available in the ESM
  // build; `__filename` is available in the CJS build tsup emits — neither
  // is available in the other, so both are tried behind guards.
  try {
    if (typeof __filename !== 'undefined') {
      return createRequire(__filename)('mongoose') as MongooseLike;
    }
  } catch { /* fall through to the next strategy */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return createRequire(import.meta.url)('mongoose') as MongooseLike;
    }
  } catch { /* fall through to the cwd fallback */ }

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

  // Critical 2: `ingestPayloadSchema` caps `items` at 5000. A caller-supplied
  // `maxSignatures` above that would let the aggregator produce a batch the
  // ingest API is guaranteed to 400 on — which `transport.ts` treats as
  // "unserviceable, drop it": silent, permanent data loss. Clamp instead of
  // trusting the caller, and say so once.
  const maxSignatures = resolveMaxSignatures(options.maxSignatures, onError);

  if (options.enabled === false) {
    // eslint-disable-next-line prefer-const
    let noop: InternalAnalyser;
    noop = {
      flush: async () => {},
      // Important 3: routes through the same "clear module state only if
      // I'm still the active one" guard as the real instance below, so
      // `noop.shutdown()` (the natural call for a TS user holding the
      // returned Analyser) doesn't leave a dead no-op instance pinned as
      // `active` forever.
      async shutdown() { clearActiveIfSelf(noop); },
      installedModels: 0,
      _stop: () => {},
      _aggregator: new Aggregator(maxSignatures),
    };
    active = noop;
    activeOptions = { apiKey: options.apiKey, app: options.app };
    return noop;
  }

  const thresholdMs = options.thresholdMs ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 10_000;
  const aggregator = new Aggregator(maxSignatures);
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
    // Fix round 1, Important 2: a single resolver, shared by both the
    // future-models plugin and the already-compiled-models loop below,
    // read at QUERY TIME by the installed pre/post closures (see
    // GetHookContext in hooks.ts) rather than captured once at install
    // time. That is what makes a model instrumented in an earlier
    // init()/shutdown() cycle automatically start (and, on shutdown, stop)
    // routing to whichever analyser is current, instead of leaking into a
    // dead one forever.
    const getCurrentCtx: GetHookContext = () => mgState[CURRENT_CTX] ?? null;

    // Fix round 4, Critical 1: everything below reaches into mongoose/kareem
    // internals (`mg.models`, `schema.pre`, `model.schema.s.hooks.clone`,
    // `model._applyQueryMiddleware`). The hot query path is guarded, but this
    // one-time install path was not — a `models` getter that throws, an
    // unusual discriminator, or a mongoose patch changing kareem's shape
    // would otherwise crash the host's boot file, breaking the SDK's second
    // promise. The whole block is wrapped so instrumentation failure always
    // degrades to "fewer (or zero) models instrumented", never a throw, and
    // each model is wrapped individually so one bad model can't stop the
    // rest from being instrumented.
    try {
      // Future models — register the plugin function itself only once ever
      // for this mongoose instance; see the CURRENT_CTX comment above for why.
      if (!mgState[PLUGIN_REGISTERED]) {
        mgState[PLUGIN_REGISTERED] = true;
        mg.plugin((schema) => { installHooks(schema, getCurrentCtx); });
      }
      // Models already compiled before init ran — without this, setup is
      // order-dependent and the one-line promise is false. See
      // reapplyPreCompiledHooks() above for why installHooks() alone is not
      // enough for a model that already existed.
      //
      // Fix round 1, Important 1 (live probe): a schema shared by two models
      // (discriminators, or two `mongoose.model()` calls given the same
      // Schema instance) is the SAME object — `installHooks` marks it
      // INSTALLED while processing the first model, so it returns `false`
      // for the second. The second model's own middleware snapshot (taken at
      // ITS `Model.compile()`, before the shared schema was ever mutated) was
      // never rebuilt, leaving it silently uninstrumented. Installing on the
      // schema (idempotent, gated by the schema's own INSTALLED symbol) and
      // reapplying on the model (once per model, whenever ITS schema ends up
      // instrumented — whether by this call or an earlier one) are now two
      // independent steps.
      const modelNames = Object.keys(mg.models);
      for (const name of modelNames) {
        try {
          const model = mg.models[name]! as unknown as PreCompiledModel;
          installHooks(model.schema, getCurrentCtx);
          const marked = model.schema as unknown as { [INSTALLED]?: boolean };
          if (marked[INSTALLED]) {
            installedModels++;
            reapplyPreCompiledHooks(model);
          }
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      // Important 4: mongoose was resolved and has models, but none of them
      // ended up instrumented — that's a silent "the SDK is doing nothing"
      // failure worth surfacing once, distinct from the per-model errors
      // above (which fire only when a model actively threw).
      if (installedModels === 0 && modelNames.length > 0) {
        onError(new Error(
          'query-analyser: mongoose was resolved but no models were instrumented — check onError above for the cause, or that schemas are compatible with this SDK version',
        ));
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
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
        // Critical 2: `??` only falls through on null/undefined, so
        // `NODE_ENV=''` (a real thing some process managers set) sailed
        // through as `env: ''`, which `ingestPayloadSchema`'s
        // `z.string().min(1)` rejects — a 400 the transport treats as
        // "drop the batch". `||` also falls through on the empty string.
        env: options.env || process.env.NODE_ENV || 'development',
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

  // eslint-disable-next-line prefer-const
  let analyser: InternalAnalyser;
  analyser = {
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
      // Important 3: see clearActiveIfSelf's comment above `active`.
      clearActiveIfSelf(analyser);
    },
    _stop() { clearInterval(timer); },
    _aggregator: aggregator,
  };

  active = analyser;
  activeOptions = { apiKey: options.apiKey, app: options.app };
  return analyser;
}

export async function shutdown(): Promise<void> {
  // Important 3: the instance's own `shutdown()` now clears module-level
  // `active`/`activeOptions` itself (via clearActiveIfSelf), so this and
  // `analyser.shutdown()` are the same operation either way it's called.
  await active?.shutdown();
}

// Public API surface fix (pre-publish): `Aggregator`, `buildSignature`,
// `redact` and `MongooseLike` used to be re-exported here. Once published to
// npm those become semver-locked forever. None of them are part of the
// SDK's actual contract with a consumer — the public surface is `init`,
// `shutdown`, `SDK_VERSION`, and the `InitOptions`/`Analyser` types (plus
// this default export). Tests that need the internals import them directly
// from their own modules (./aggregator.js, ./signature.js, ./redact.js).
export default { init, shutdown };
