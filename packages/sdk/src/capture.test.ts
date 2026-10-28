import { describe, it, expect } from 'vitest';
import { ingestPayloadSchema } from '@query-analyser/contract';
import { mapCommand } from './command-map.js';
import { shapeOf } from './capture.js';
import { buildSignature } from './signature.js';
import { Aggregator } from './aggregator.js';

describe('shapeOf', () => {
  it('builds the 0.2 signature and redacted sample from the mapped statement', () => {
    const [st] = mapCommand('find', 'app', { find: 'users', filter: { email: 'a@x', age: { $gte: 1 } }, sort: new Map([['age', -1]]) });
    const shape = shapeOf(st!, 'User');
    expect(shape.sig).toEqual(buildSignature({ model: 'User', operation: 'find', filter: st!.filter, sort: { age: -1 } }));
    expect(shape.sample).toEqual({ filter: { email: '<string>', age: { $gte: '<number>' } }, sort: { age: '<number>' } });
    expect(shape.collection).toBe('users');
  });

  it('insert has a null sample', () => {
    const [st] = mapCommand('insert', 'app', { insert: 'orders', documents: [{ secret: 1 }] });
    const shape = shapeOf(st!, 'orders');
    expect(shape.sample).toBeNull();
    expect(shape.sig.signature).toBe('orders.insert()');
  });

  it('truncates a model name to 200 and a collection to 255 characters, and the batch validates', () => {
    const long = 'c'.repeat(250);
    const [st] = mapCommand('find', 'app', { find: long, filter: {} });
    const shape = shapeOf(st!, long);
    expect(shape.sig.model).toHaveLength(200);
    expect(shape.collection).toHaveLength(250);
    const tooLong = shapeOf({ ...st!, collection: 'd'.repeat(300) }, long);
    expect(tooLong.collection).toHaveLength(255);

    const agg = new Aggregator(10);
    agg.add(shape.sig, 150, shape.sample, undefined, shape.collection);
    const item = agg.swap().items[0]!;
    const wire = {
      signature: item.signature, hash: item.hash, model: item.model, operation: item.operation,
      filterShape: item.filterShape, sortKeys: item.sortKeys, stages: item.stages,
      count: item.count, totalMs: item.totalMs, maxMs: item.maxMs, lastMs: item.lastMs,
      lastTs: item.lastTs, hist: item.hist, sample: item.sample,
      source: 'mongodb', collection: item.collection,
    };
    const result = ingestPayloadSchema.safeParse({
      app: 'a', env: 'e', host: 'h', sdkVersion: '0.3.0', bucket: '2026102814',
      thresholdMs: 100, dropped: 0, items: [wire],
    });
    expect(result.success).toBe(true);
  });
});
