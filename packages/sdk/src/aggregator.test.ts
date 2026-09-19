import { describe, it, expect } from 'vitest';
import { Aggregator } from './aggregator.js';
import { buildSignature } from './signature.js';

const sigA = buildSignature({ model: 'Order', operation: 'find', filter: { status: 'paid' } });
const sigB = buildSignature({ model: 'User', operation: 'findOne', filter: { email: 'x' } });

describe('Aggregator', () => {
  it('folds repeated occurrences of one signature into a single item', () => {
    const agg = new Aggregator(100);
    agg.add(sigA, 120, { status: '<string>' });
    agg.add(sigA, 300, { status: '<string>' });
    const { items } = agg.swap();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ hash: sigA.hash, count: 2, totalMs: 420, maxMs: 300, lastMs: 300 });
    expect(items[0]!.hist).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('keeps distinct signatures apart', () => {
    const agg = new Aggregator(100);
    agg.add(sigA, 120, null);
    agg.add(sigB, 120, null);
    expect(agg.swap().items).toHaveLength(2);
  });

  it('empties itself on swap so the next window starts clean', () => {
    const agg = new Aggregator(100);
    agg.add(sigA, 120, null);
    expect(agg.swap().items).toHaveLength(1);
    expect(agg.swap().items).toHaveLength(0);
    expect(agg.size).toBe(0);
  });

  it('drops new signatures past the cap and counts the drops', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);
    agg.add(sigB, 120, null);
    const { items, dropped } = agg.swap();
    expect(items).toHaveLength(1);
    expect(dropped).toBe(1);
  });

  it('still aggregates a known signature after the cap is reached', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);
    agg.add(sigB, 120, null);   // dropped
    agg.add(sigA, 200, null);   // known — must still count
    const { items } = agg.swap();
    expect(items[0]).toMatchObject({ count: 2 });
  });

  it('reports the drop count once and then resets it', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);
    agg.add(sigB, 120, null);
    expect(agg.swap().dropped).toBe(1);
    expect(agg.swap().dropped).toBe(0);
  });

  it('keeps the sample from the slowest occurrence', () => {
    const agg = new Aggregator(10);
    agg.add(sigA, 120, { tag: 'slow-120' });
    agg.add(sigA, 900, { tag: 'slow-900' });
    agg.add(sigA, 200, { tag: 'slow-200' });
    expect(agg.swap().items[0]!.sample).toEqual({ tag: 'slow-900' });
  });

  it('merges a returned batch back, summing counts and adding histograms elementwise', () => {
    const agg = new Aggregator(10);
    agg.add(sigA, 120, null);
    const first = agg.swap().items;

    agg.add(sigA, 300, null);
    agg.merge(first);

    const { items } = agg.swap();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ count: 2, totalMs: 420, maxMs: 300 });
    expect(items[0]!.hist[0]).toBe(1);
    expect(items[0]!.hist[1]).toBe(1);
  });

  it('refuses to merge past the cap rather than growing without bound', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);
    agg.merge([{ ...agg.swap().items[0]!, hash: 'ffffffffffffffff' }]);
    agg.add(sigA, 120, null);
    expect(agg.size).toBeLessThanOrEqual(1);
  });
});
