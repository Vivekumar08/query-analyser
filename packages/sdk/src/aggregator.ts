import type { IngestItem } from '@query-analyser/contract/runtime';
import { HIST_SIZE } from '@query-analyser/contract/runtime';
import { addToHist, newHist } from './histogram.js';
import type { SignatureResult } from './signature.js';

/**
 * In-memory fold of slow queries by signature. The only state the hot path
 * touches. `swap()` hands the window to the transport and starts a fresh one.
 */
export class Aggregator {
  private buffer = new Map<string, IngestItem>();
  private droppedCount = 0;

  constructor(private readonly maxSignatures: number) {}

  get size(): number {
    return this.buffer.size;
  }

  add(sig: SignatureResult, durationMs: number, sample: unknown): void {
    let item = this.buffer.get(sig.hash);

    if (!item) {
      if (this.buffer.size >= this.maxSignatures) {
        this.droppedCount++;
        return;
      }
      item = {
        signature: sig.signature,
        hash: sig.hash,
        model: sig.model,
        operation: sig.operation,
        filterShape: sig.filterShape,
        sortKeys: sig.sortKeys,
        stages: sig.stages,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        lastMs: 0,
        lastTs: 0,
        hist: newHist(),
        sample: null,
      };
      this.buffer.set(sig.hash, item);
    }

    item.count += 1;
    item.totalMs += durationMs;
    item.lastMs = durationMs;
    item.lastTs = Date.now();
    addToHist(item.hist, durationMs);
    if (durationMs >= item.maxMs) {
      item.maxMs = durationMs;
      item.sample = sample;   // keep the sample from the worst occurrence
    }
  }

  /** Take the current window and reset. */
  swap(): { items: IngestItem[]; dropped: number } {
    const items = [...this.buffer.values()];
    const dropped = this.droppedCount;
    this.buffer = new Map();
    this.droppedCount = 0;
    return { items, dropped };
  }

  /** Fold an un-delivered batch back in, bounded by the same cap. */
  merge(items: IngestItem[]): void {
    for (const incoming of items) {
      const existing = this.buffer.get(incoming.hash);
      if (!existing) {
        if (this.buffer.size >= this.maxSignatures) { this.droppedCount++; continue; }
        this.buffer.set(incoming.hash, { ...incoming, hist: [...incoming.hist] });
        continue;
      }
      existing.count += incoming.count;
      existing.totalMs += incoming.totalMs;
      for (let i = 0; i < HIST_SIZE; i++) {
        existing.hist[i] = (existing.hist[i] ?? 0) + (incoming.hist[i] ?? 0);
      }
      if (incoming.maxMs > existing.maxMs) {
        existing.maxMs = incoming.maxMs;
        existing.sample = incoming.sample;
      }
      if (incoming.lastTs > existing.lastTs) {
        existing.lastTs = incoming.lastTs;
        existing.lastMs = incoming.lastMs;
      }
    }
  }
}
