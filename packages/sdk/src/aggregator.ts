import type { IngestItem } from './types.js';
import { HIST_SIZE, FINE_HIST_BOUNDS, FINE_HIST_SIZE } from '@query-analyser/contract/runtime';
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
  /** SQL items only: failed-statement counts by SQLSTATE. Folded to `errorCodes` on the wire. */
  codeCounts?: Map<string, number>;
}

/** One captured SQL statement, already normalised and labelled. */
export interface SqlStatement {
  hash: string;
  signature: string;
  model: string;
  operation: string;
  table: string | null;
  orm?: string;
  database?: string;
  sql: string;
  durationMs: number;
  slow: boolean;
  /** 1 / sampleRate for a sampled-in fast statement, else 1. */
  weight: number;
  failed: boolean;
  errorCode: string | null;
  sampleRate: number;
}

/** Index of the fine-histogram bucket a duration belongs to. The last bucket is unbounded. */
export function fineBucketIndex(ms: number): number {
  for (let i = 0; i < FINE_HIST_BOUNDS.length; i++) {
    if (ms < FINE_HIST_BOUNDS[i]!) return i;
  }
  return FINE_HIST_SIZE - 1;
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

  /**
   * Fold one SQL statement in. False when its hash is new and the cap is
   * reached (counted as dropped).
   */
  addStatement(st: SqlStatement): boolean {
    let item = this.buffer.get(st.hash);
    if (!item) {
      if (this.buffer.size >= this.maxSignatures) {
        this.droppedCount++;
        return false;
      }
      item = {
        signature: st.signature,
        hash: st.hash,
        model: st.model,
        operation: st.operation,
        filterShape: [],
        sortKeys: [],
        stages: [],
        count: 0,
        totalMs: 0,
        maxMs: 0,
        lastMs: 0,
        lastTs: 0,
        hist: newHist(),
        sample: null,
        source: 'postgresql',
        collection: (st.table ?? st.model).slice(0, 255),
        ...(st.orm !== undefined ? { orm: st.orm } : {}),
        ...(st.database !== undefined ? { database: st.database } : {}),
        sql: st.sql,
        errors: 0,
        histFine: new Array<number>(FINE_HIST_SIZE).fill(0),
      };
      this.buffer.set(st.hash, item);
    }

    const ms = st.durationMs;
    item.count += st.weight;
    item.totalMs += ms * st.weight;
    const fi = fineBucketIndex(ms);
    const hf = (item.histFine ??= new Array<number>(FINE_HIST_SIZE).fill(0));
    hf[fi] = (hf[fi] ?? 0) + st.weight;
    if (st.slow) addToHist(item.hist, ms);
    if (ms >= item.maxMs) item.maxMs = ms;
    item.lastMs = ms;
    item.lastTs = Date.now();
    if (st.failed) {
      item.errors = (item.errors ?? 0) + 1;
      if (st.errorCode) {
        const codes = (item.codeCounts ??= new Map());
        codes.set(st.errorCode, (codes.get(st.errorCode) ?? 0) + 1);
      }
    }
    if (st.sampleRate < 1) item.sampleRate = Math.min(item.sampleRate ?? 1, st.sampleRate);
    if (item.orm === undefined && st.orm !== undefined) {
      item.orm = st.orm;
      item.model = st.model;
      item.operation = st.operation;
    }
    return true;
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
        const copy: AggregatedItem = { ...incoming, hist: [...incoming.hist] };
        if (incoming.histFine) copy.histFine = [...incoming.histFine];
        if (incoming.codeCounts) copy.codeCounts = new Map(incoming.codeCounts);
        this.buffer.set(incoming.hash, copy);
        continue;
      }
      existing.count += incoming.count;
      existing.totalMs += incoming.totalMs;
      for (let i = 0; i < HIST_SIZE; i++) {
        existing.hist[i] = (existing.hist[i] ?? 0) + (incoming.hist[i] ?? 0);
      }
      if (incoming.histFine) {
        const hf = (existing.histFine ??= new Array<number>(FINE_HIST_SIZE).fill(0));
        for (let i = 0; i < FINE_HIST_SIZE; i++) hf[i] = (hf[i] ?? 0) + (incoming.histFine[i] ?? 0);
      }
      if (incoming.errors) existing.errors = (existing.errors ?? 0) + incoming.errors;
      if (incoming.codeCounts) {
        const codes = (existing.codeCounts ??= new Map());
        for (const [code, n] of incoming.codeCounts) codes.set(code, (codes.get(code) ?? 0) + n);
      }
      if (incoming.sampleRate !== undefined) {
        existing.sampleRate = Math.min(existing.sampleRate ?? 1, incoming.sampleRate);
      }
      if (existing.orm === undefined && incoming.orm !== undefined) {
        existing.orm = incoming.orm;
        existing.model = incoming.model;
        existing.operation = incoming.operation;
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
