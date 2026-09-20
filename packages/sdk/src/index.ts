import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { bucketOf } from '@query-analyser/contract/runtime';
import type { IngestPayload } from '@query-analyser/contract/runtime';
import { Aggregator } from './aggregator.js';
import { installHooks, type MongooseSchemaLike } from './hooks.js';
import { createTransport } from './transport.js';

export const SDK_VERSION = '0.1.0';
const DEFAULT_ENDPOINT = 'https://ingest.query-analyser.dev/v1/ingest';

export interface MongooseLike {
  plugin(fn: (schema: MongooseSchemaLike) => void): unknown;
  models: Record<string, { schema: MongooseSchemaLike }>;
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
    // Future models.
    mg.plugin((schema) => { installHooks(schema, ctx); });
    // Models already compiled before init ran — without this, setup is
    // order-dependent and the one-line promise is false.
    for (const name of Object.keys(mg.models)) {
      if (installHooks(mg.models[name]!.schema, ctx)) installedModels++;
    }
  }

  const doFlush = async (): Promise<void> => {
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
