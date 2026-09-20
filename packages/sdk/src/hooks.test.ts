import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { installHooks, type MongooseSchemaLike } from './hooks.js';
import { Aggregator } from './aggregator.js';

function ctx(threshold = 0, isDisabled: () => boolean = () => false) {
  return { aggregator: new Aggregator(100), thresholdMs: threshold, onError: vi.fn(), isDisabled };
}

type RecordedFns = {
  pre?: (this: unknown, next: () => void) => void;
  post?: (this: unknown, res: unknown, next: () => void) => void;
};

function fakeSchemaRecording(recorded: RecordedFns): MongooseSchemaLike {
  const schema: MongooseSchemaLike = {
    pre(_match, fn) {
      recorded.pre = fn;
      return schema;
    },
    post(_match, fn) {
      recorded.post = fn;
      return schema;
    },
  };
  return schema;
}

function fakeQuery() {
  return {
    op: 'find',
    _model: { modelName: 'Fake' },
    getQuery: () => ({ a: 1 }),
  } as {
    _qaStart?: number;
    op: string;
    _model: { modelName: string };
    getQuery: () => unknown;
  };
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

    const recorded: RecordedFns = {};
    installHooks(fakeSchemaRecording(recorded), c);

    const fakeThis = fakeQuery();

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

  // Fix round 1, Important 2: once the transport latch trips (401/403), the
  // hot path must stop touching the aggregator entirely, not just stop
  // flushing.
  it('skips the aggregator entirely once disabled', () => {
    const c = ctx(0, () => true);
    const addSpy = vi.spyOn(c.aggregator, 'add');

    const recorded: RecordedFns = {};
    installHooks(fakeSchemaRecording(recorded), c);

    const fakeThis = fakeQuery();

    const preNext = vi.fn();
    recorded.pre!.call(fakeThis, preNext);
    fakeThis._qaStart = (fakeThis._qaStart as number) - 5;

    const postNext = vi.fn();
    recorded.post!.call(fakeThis, {}, postNext);

    expect(addSpy).not.toHaveBeenCalled();
    expect(postNext).toHaveBeenCalledTimes(1);
    expect(c.onError).not.toHaveBeenCalled();
  });
});
