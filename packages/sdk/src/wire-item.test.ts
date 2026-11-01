import { describe, it, expect } from 'vitest';
import { ingestPayloadSchema } from '@query-analyser/contract';
import { Aggregator, type SqlStatement } from './aggregator.js';
import { buildSignature } from './signature.js';
import { roundWeighted, toWireItem } from './wire-item.js';

const MONGO_03_KEYS = [
  'signature', 'hash', 'model', 'operation', 'filterShape', 'sortKeys', 'stages',
  'count', 'totalMs', 'maxMs', 'lastMs', 'lastTs', 'hist', 'sample', 'source', 'collection',
];
const sigA = buildSignature({ model: 'Order', operation: 'find', filter: { status: 'paid' } });

function stmt(over: Partial<SqlStatement> = {}): SqlStatement {
  return {
    hash: 'h'.repeat(16), signature: 'SELECT ?', model: 'users', operation: 'select', table: 'users',
    sql: 'SELECT ?', durationMs: 5, slow: false, weight: 1, failed: false, errorCode: null, sampleRate: 1,
    ...over,
  };
}
const basePayload = {
  app: 'a', env: 'test', host: 'h', sdkVersion: '0.4.0', bucket: '2026110113', thresholdMs: 100, dropped: 0,
};

describe('roundWeighted', () => {
  it('keeps the total and rounds by largest remainder', () => {
    expect(roundWeighted([10, 10, 10, 0.4])).toEqual([10, 10, 10, 0]);
    expect(roundWeighted([3.4, 3.4, 3.2])).toEqual([4, 3, 3]);
    expect(roundWeighted([0, 0])).toEqual([0, 0]);
  });
});

describe('toWireItem', () => {
  it('a Mongo item serialises exactly as 0.3', () => {
    const agg = new Aggregator(10);
    agg.add(sigA, 120, null, undefined, 'orders');
    expect(Object.keys(toWireItem(agg.swap().items[0]!))).toEqual(MONGO_03_KEYS);
  });

  it('a SQL item carries the SQL keys after collection, in order', () => {
    const agg = new Aggregator(10);
    agg.addStatement(stmt({ durationMs: 150, slow: true, failed: true, errorCode: '23505', orm: 'prisma', database: 'shop' }));
    const w = toWireItem(agg.swap().items[0]!);
    expect(Object.keys(w)).toEqual([...MONGO_03_KEYS, 'orm', 'database', 'sql', 'errors', 'histFine', 'errorCodes']);
    expect(w).toMatchObject({ source: 'postgresql', count: 1, errors: 1, errorCodes: [{ code: '23505', count: 1 }], hist: [0, 1, 0, 0, 0, 0, 0, 0] });
    expect(ingestPayloadSchema.safeParse({ ...basePayload, items: [w] }).success).toBe(true);
  });

  it('weighted fast statements round so the fine buckets sum to count; hist stays exact', () => {
    const agg = new Aggregator(10);
    for (let i = 0; i < 3; i++) agg.addStatement(stmt({ durationMs: 3, weight: 10, sampleRate: 0.1 }));
    agg.addStatement(stmt({ durationMs: 150, slow: true, weight: 1, sampleRate: 0.1 }));
    const w = toWireItem(agg.swap().items[0]!);
    expect(w.count).toBe(31);
    expect(w.histFine!.reduce((a, b) => a + b, 0)).toBe(31);
    expect(w.hist).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    expect(w.sampleRate).toBe(0.1);
    expect(Object.keys(w).at(-1)).toBe('sampleRate');
  });

  it('keeps only the top 8 error codes, highest count first then code ascending', () => {
    const agg = new Aggregator(10);
    for (let c = 0; c < 10; c++) {
      for (let n = 0; n < 10 - c; n++) agg.addStatement(stmt({ failed: true, errorCode: `2300${c}` }));
    }
    const w = toWireItem(agg.swap().items[0]!);
    expect(w.errorCodes).toHaveLength(8);
    expect(w.errorCodes![0]).toEqual({ code: '23000', count: 10 });
    expect(w.errorCodes![7]).toEqual({ code: '23007', count: 3 });
  });

  it('omits errorCodes and sampleRate when there are none', () => {
    const agg = new Aggregator(10);
    agg.addStatement(stmt());
    const w = toWireItem(agg.swap().items[0]!);
    expect(w).not.toHaveProperty('errorCodes');
    expect(w).not.toHaveProperty('sampleRate');
    expect(w).not.toHaveProperty('orm');
  });
});
