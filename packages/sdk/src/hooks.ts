import type { Aggregator } from './aggregator.js';
import { buildSignature } from './signature.js';
import { redact } from './redact.js';

// Exported so index.ts can check "is this schema already instrumented?"
// without re-deriving the same Symbol.for key in two places (fix round 1,
// Important 1 — see reapplyPreCompiledHooks's caller in index.ts).
export const INSTALLED = Symbol.for('query-analyser.installed');

const QUERY_OPS = /^(find|findOne|findOneAnd|count|countDocuments|distinct|update|updateOne|updateMany|replaceOne|deleteOne|deleteMany)/;

export interface HookContext {
  aggregator: Aggregator;
  thresholdMs: number;
  onError: (e: Error) => void;
  isDisabled: () => boolean;
}

/** Minimal structural type so the SDK never imports mongoose at runtime. */
export interface MongooseSchemaLike {
  pre(match: RegExp | string, fn: (this: unknown, next: () => void) => void): unknown;
  post(match: RegExp | string, fn: (this: unknown, res: unknown, next: () => void) => void): unknown;
}

type TimedQuery = {
  _qaStart?: number;
  op?: string;
  model?: unknown;
  _model?: unknown;
  getQuery?: () => unknown;
  getOptions?: () => { sort?: unknown };
  getUpdate?: () => unknown;
  pipeline?: () => unknown[];
};

// Bug found by the real-mongoose integration test: `q.model` on a mongoose
// Query is the Model *constructor itself* (a function), not a getter to
// call — mongoose Models can legally be invoked without `new` to build a
// bare document, so treating `typeof q.model === 'function'` as "call it to
// get the model" silently built a throwaway document with no `modelName`
// and produced `model: 'unknown'` for every real query. Read `.modelName`
// directly off whichever of `_model` (set on Aggregate) or `model` (set on
// Query) is present instead of ever invoking it.
function modelNameOf(q: TimedQuery): string {
  const m = q._model ?? q.model;
  return (m as { modelName?: string } | undefined)?.modelName ?? 'unknown';
}

// Fix round 1, Important 2: `installHooks` used to take a concrete
// `HookContext` object, captured directly by the pre/post closures below.
// That was fine for models compiled while a plugin fires (the caller
// re-resolved "current" before calling installHooks), but for a model
// instrumented once and then left alone across a shutdown()+init() cycle,
// the OLD ctx (its aggregator, its transport) stayed captured forever — a
// live-verified leak: a model instrumented in cycle 1 kept silently
// reporting into cycle 1's orphaned aggregator after cycle 2's init(),
// under-reporting to the new analyser and leaking memory indefinitely.
// Taking a resolver instead — called fresh on every query — means every
// already-instrumented schema always routes to whatever context is
// current *right now*, and to nothing (a clean no-op) when there is none.
export type GetHookContext = () => HookContext | null;

export function installHooks(schema: MongooseSchemaLike, getCtx: GetHookContext): boolean {
  const s = schema as MongooseSchemaLike & { [INSTALLED]?: boolean };
  if (s[INSTALLED]) return false;
  Object.defineProperty(s, INSTALLED, { value: true, enumerable: false });

  const pre = function (this: unknown, next: () => void) {
    const self = this as TimedQuery;
    self._qaStart = Date.now();
    next();
  };

  const post = function (this: unknown, _res: unknown, next: () => void) {
    const self = this as TimedQuery;
    const ctx = getCtx();
    if (!ctx) return next();
    try {
      if (ctx.isDisabled()) return next();
      if (self._qaStart == null) return next();
      const duration = Date.now() - self._qaStart;
      // Bug found by the real-mongoose integration test: `Date.now()` has
      // millisecond granularity, so a query on an in-memory mongod
      // frequently completes within the same millisecond it started in,
      // measuring as a 0ms duration. With `thresholdMs: 0` (meaning "every
      // query counts", per the integration tests) a strict `duration <=
      // thresholdMs` skip silently dropped every 0ms-duration query even
      // though 0 >= 0. A query at exactly the threshold is "at least this
      // slow" and should count; only strictly-faster-than-threshold queries
      // are skipped.
      if (duration < ctx.thresholdMs) return next();

      const isAggregate = typeof self.pipeline === 'function';
      const pipeline = isAggregate ? self.pipeline!() : undefined;
      const filter = !isAggregate && self.getQuery ? self.getQuery() : undefined;
      const update = !isAggregate && self.getUpdate ? self.getUpdate() : undefined;
      const sort = !isAggregate && self.getOptions ? self.getOptions()?.sort : undefined;

      const sig = buildSignature({
        model: modelNameOf(self),
        operation: isAggregate ? 'aggregate' : (self.op ?? 'unknown'),
        filter, sort, pipeline,
      });

      // Minor fix 9: `update`/`sort` were always included even when
      // `undefined` (most finds have no update; unsorted queries have no
      // sort), so the real sample looked like
      // `{"filter":{...},"update":"<undefined>","sort":"<undefined>"}` —
      // not the README's example. Omit a key entirely when its value is
      // undefined, matching what the README now shows.
      const sampleInput: Record<string, unknown> = isAggregate
        ? { pipeline }
        : { filter, ...(update !== undefined ? { update } : {}), ...(sort !== undefined ? { sort } : {}) };
      const sample = redact(sampleInput);
      ctx.aggregator.add(sig, duration, sample);
    } catch (err) {
      ctx.onError(err instanceof Error ? err : new Error(String(err)));
    }
    next();
  };

  schema.pre(QUERY_OPS, pre);
  schema.post(QUERY_OPS, post);
  schema.pre('aggregate', pre);
  schema.post('aggregate', post);

  return true;
}
