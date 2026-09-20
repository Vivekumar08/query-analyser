import { describe, it, expect } from 'vitest';
import type { IngestItem } from './types.js';
import type { SignatureResult } from './signature.js';
import { Aggregator } from './aggregator.js';
import { buildSignature } from './signature.js';
import { newHist, addToHist } from './histogram.js';

const sigA = buildSignature({ model: 'Order', operation: 'find', filter: { status: 'paid' } });
const sigB = buildSignature({ model: 'User', operation: 'findOne', filter: { email: 'x' } });

function buildItem(sig: SignatureResult): IngestItem {
  const hist = newHist();
  addToHist(hist, 120);
  return {
    signature: sig.signature,
    hash: sig.hash,
    model: sig.model,
    operation: sig.operation,
    filterShape: sig.filterShape,
    sortKeys: sig.sortKeys,
    stages: sig.stages,
    count: 1,
    totalMs: 120,
    maxMs: 120,
    lastMs: 120,
    lastTs: Date.now(),
    hist,
    sample: null,
  };
}

describe('Aggregator', () => {
  it('folds repeated occurrences of one signature into a single item', () => {
    const agg = new Aggregator(100);
    agg.add(sigA, 120, { status: '<string>' });
    agg.add(sigA, 300, { status: '<string>' });
    const { items } = agg.swap();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ hash: sigA.hash, count: 2, totalMs: 420, maxMs: 300, lastMs: 300 });
    expect(items[0]!.hist).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);
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
    expect(items[0]!.hist[1]).toBe(1);
    expect(items[0]!.hist[2]).toBe(1);
  });

  it('refuses to merge an unseen signature past the cap and counts the drop', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);                         // buffer is now at cap (1)
    const foreign = { ...buildItem(sigB), hash: 'ffffffffffffffff' };
    agg.merge([foreign]);                             // unseen hash, buffer full → must drop
    expect(agg.size).toBe(1);
    const { items, dropped } = agg.swap();
    expect(items[0]!.hash).toBe(sigA.hash);
    expect(dropped).toBe(1);
  });

  it('still folds a known signature when merging at cap', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);                         // buffer is now at cap (1)
    const sameHash = { ...buildItem(sigA), hash: sigA.hash };
    agg.merge([sameHash]);                            // known hash → must fold in, no drop
    expect(agg.size).toBe(1);
    const { items, dropped } = agg.swap();
    expect(items[0]!.count).toBe(2);                  // 1 from add + 1 from merge
    expect(dropped).toBe(0);
  });
});
