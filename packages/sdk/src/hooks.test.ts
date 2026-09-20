import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { installHooks } from './hooks.js';
import { Aggregator } from './aggregator.js';

function ctx(threshold = 0) {
  return { aggregator: new Aggregator(100), thresholdMs: threshold, onError: vi.fn() };
}

describe('installHooks', () => {
  it('installs only once per schema', () => {
    const schema = new mongoose.Schema({ a: String });
    expect(installHooks(schema, ctx())).toBe(true);
    expect(installHooks(schema, ctx())).toBe(false);
  });

  // Controller Ruling C: the brief's version runs a real query with no live
  // connection, which mongoose buffers and rejects on a ~10s timeout — slow
  // and the post hook likely never fires, making the assertion vacuous.
  // Instead, exercise the installed post hook directly against a hand-built
  // fake query object and force a failure inside ctx.aggregator.add.
  it('never lets an internal failure escape into the query', () => {
    const c = ctx();
    vi.spyOn(c.aggregator, 'add').mockImplementation(() => {
      throw new Error('boom');
    });

    const recorded: { pre?: (this: unknown, next: () => void) => void; post?: (this: unknown, res: unknown, next: () => void) => void } = {};
    const fakeSchema = {
      pre(_match: RegExp | string, fn: (this: unknown, next: () => void) => void) {
        recorded.pre = fn;
        return fakeSchema;
      },
      post(_match: RegExp | string, fn: (this: unknown, res: unknown, next: () => void) => void) {
        recorded.post = fn;
        return fakeSchema;
      },
    };

    installHooks(fakeSchema, c);

    const fakeThis: {
      _qaStart?: number;
      op: string;
      _model: { modelName: string };
      getQuery: () => unknown;
    } = {
      op: 'find',
      _model: { modelName: 'Fake' },
      getQuery: () => ({ a: 1 }),
    };

    const preNext = vi.fn();
    recorded.pre!.call(fakeThis, preNext);
    expect(preNext).toHaveBeenCalledTimes(1);
    expect(fakeThis._qaStart).toBeTypeOf('number');
    // Push the recorded start back so the post hook sees a duration that
    // exceeds thresholdMs: 0 and actually reaches ctx.aggregator.add.
    fakeThis._qaStart = (fakeThis._qaStart as number) - 5;

    const postNext = vi.fn();
    expect(() => recorded.post!.call(fakeThis, {}, postNext)).not.toThrow();

    expect(postNext).toHaveBeenCalledTimes(1);
    expect(c.onError).toHaveBeenCalledTimes(1);
    expect((c.onError.mock.calls[0]![0] as Error).message).toBe('boom');
  });
});
