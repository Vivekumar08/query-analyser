import type { Aggregator } from './aggregator.js';
import { buildSignature } from './signature.js';
import { redact } from './redact.js';

const INSTALLED = Symbol.for('query-analyser.installed');

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

function modelNameOf(q: TimedQuery): string {
  const m = q._model ?? (typeof q.model === 'function' ? (q.model as () => unknown)() : q.model);
  return (m as { modelName?: string } | undefined)?.modelName ?? 'unknown';
}

export function installHooks(schema: MongooseSchemaLike, ctx: HookContext): boolean {
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
    try {
      if (ctx.isDisabled()) return next();
      if (self._qaStart == null) return next();
      const duration = Date.now() - self._qaStart;
      if (duration <= ctx.thresholdMs) return next();

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

      const sample = redact(isAggregate ? { pipeline } : { filter, update, sort });
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
