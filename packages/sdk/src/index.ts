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

let active: (Analyser & { _stop(): void }) | null = null;

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
  if (!options.apiKey) throw new Error('query-analyser: apiKey is required');
  if (!options.app) throw new Error('query-analyser: app is required');

  if (active) return active;

  const onError = options.onError
    ?? ((e: Error) => process.stderr.write(`[query-analyser] ${e.message}\n`));

  if (options.enabled === false) {
    const noop: Analyser & { _stop(): void } = {
      flush: async () => {}, shutdown: async () => {}, installedModels: 0, _stop: () => {},
    };
    active = noop;
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

  const ctx = { aggregator, thresholdMs, onError };
  let installedModels = 0;
  let disabled = false;
  let backoffUntil = 0;

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

  const flush = async (): Promise<void> => {
    if (disabled || Date.now() < backoffUntil) return;
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

  const timer = setInterval(() => { void flush(); }, flushIntervalMs);
  timer.unref();

  const onExit = () => { void flush(); };
  process.once('beforeExit', onExit);
  process.once('SIGTERM', onExit);

  const analyser: Analyser & { _stop(): void } = {
    flush,
    installedModels,
    async shutdown() {
      clearInterval(timer);
      process.off('beforeExit', onExit);
      process.off('SIGTERM', onExit);
      backoffUntil = 0;
      await flush();
    },
    _stop() { clearInterval(timer); },
  };

  active = analyser;
  return analyser;
}

export async function shutdown(): Promise<void> {
  const a = active;
  active = null;
  await a?.shutdown();
}

export { Aggregator } from './aggregator.js';
export { buildSignature } from './signature.js';
export { redact } from './redact.js';
export default { init, shutdown };
