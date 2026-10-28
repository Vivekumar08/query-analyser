import type { IngestItem } from './types.js';
import { HIST_SIZE } from '@query-analyser/contract/runtime';
import { addToHist, bucketIndex, newHist } from './histogram.js';
import type { SignatureResult } from './signature.js';
import { serializeSample } from './ejson.js';

/**
 * A buffered item: the wire item plus, when sample encryption is on, the
 * serialised real-value sample of its slowest occurrence — a string of at
 * most 16 KiB, never the query's own objects. `sampleText` lives only in
 * memory until the flush encrypts it; it is never put on the wire.
 */
export interface AggregatedItem extends IngestItem {
  sampleText?: string;
}

/** A handle on one counted occurrence, so a later getMore can extend it. */
export interface Occurrence {
  readonly hash: string;
  readonly generation: number;
  ms: number;
}

/**
 * In-memory fold of slow queries by signature. The only state the hot path
 * touches. `swap()` hands the window to the transport and starts a fresh one.
 */
export class Aggregator {
  private buffer = new Map<string, AggregatedItem>();
  private droppedCount = 0;
  private gen = 0;

  constructor(private readonly maxSignatures: number) {}

  get size(): number {
    return this.buffer.size;
  }

  /** Incremented on every swap(). */
  get generation(): number {
    return this.gen;
  }

  /**
   * `rawSample` (the unredacted sample input, only when encryption is on) is
   * serialised here, synchronously and bounded, and only when this occurrence
   * becomes the slowest for its signature. The object itself is never kept.
   */
  add(sig: SignatureResult, durationMs: number, sample: unknown, rawSample?: unknown, collection?: string): Occurrence | null {
    let item = this.buffer.get(sig.hash);

    if (!item) {
      if (this.buffer.size >= this.maxSignatures) {
        this.droppedCount++;
        return null;
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
        collection: collection ?? sig.model,
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
      setSampleText(item, rawSample === undefined ? undefined : serializeSample(rawSample));
    }
    return { hash: sig.hash, generation: this.gen, ms: durationMs };
  }

  /** Add `extraMs` to a counted occurrence. False once its window was swapped. */
  extend(occ: Occurrence, extraMs: number): boolean {
    if (occ.generation !== this.gen) return false;
    const item = this.buffer.get(occ.hash);
    if (!item) return false;
    const from = bucketIndex(occ.ms);
    const to = bucketIndex(occ.ms + extraMs);
    if (from !== to) {
      item.hist[from] = Math.max(0, (item.hist[from] ?? 0) - 1);
      item.hist[to] = (item.hist[to] ?? 0) + 1;
    }
    item.totalMs += extraMs;
    item.maxMs = Math.max(item.maxMs, occ.ms + extraMs);
    occ.ms += extraMs;
    return true;
  }

  /** Take the current window and reset. */
  swap(): { items: AggregatedItem[]; dropped: number } {
    const items = [...this.buffer.values()];
    const dropped = this.droppedCount;
    this.buffer = new Map();
    this.droppedCount = 0;
    this.gen++;
    return { items, dropped };
  }

  /** Fold an un-delivered batch back in, bounded by the same cap. */
  merge(items: AggregatedItem[]): void {
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
        setSampleText(existing, incoming.sampleText);
      }
      if (incoming.lastTs > existing.lastTs) {
        existing.lastTs = incoming.lastTs;
        existing.lastMs = incoming.lastMs;
      }
    }
  }
}

/**
 * The sample text always belongs to the same occurrence as `sample`; none
 * captured (or over the 16 KiB cap) clears any older one.
 */
function setSampleText(item: AggregatedItem, text: string | null | undefined): void {
  if (typeof text === 'string') item.sampleText = text;
  else delete item.sampleText;
}
