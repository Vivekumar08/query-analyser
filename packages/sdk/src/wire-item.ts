import type { IngestItem } from './types.js';
import type { AggregatedItem } from './aggregator.js';

const MAX_ERROR_CODES = 8;

/**
 * Round non-negative weights to integers whose sum is Math.round(sum(weights)),
 * by the largest-remainder method. Ties go to the lower index.
 */
export function roundWeighted(weights: readonly number[]): number[] {
  const floors = weights.map((w) => Math.floor(w));
  const target = Math.round(weights.reduce((a, b) => a + b, 0));
  let extra = target - floors.reduce((a, b) => a + b, 0);
  if (extra > 0) {
    const order = weights
      .map((w, i) => ({ i, r: w - Math.floor(w) }))
      .sort((x, y) => y.r - x.r || x.i - y.i);
    for (const { i } of order) {
      if (extra <= 0) break;
      floors[i] = (floors[i] ?? 0) + 1;
      extra--;
    }
  }
  return floors;
}

/**
 * The wire form of a buffered item: exactly the IngestItem keys, in the
 * order the payload has always used (so no-key Mongo payloads stay
 * byte-identical). SQL items append their extra keys after `collection`.
 */
export function toWireItem(item: AggregatedItem): IngestItem {
  const isSql = item.source !== undefined && item.source !== 'mongodb';
  const fine = isSql && item.histFine ? roundWeighted(item.histFine) : null;
  const wire: IngestItem = {
    signature: item.signature,
    hash: item.hash,
    model: item.model,
    operation: item.operation,
    filterShape: item.filterShape,
    sortKeys: item.sortKeys,
    stages: item.stages,
    count: fine ? fine.reduce((a, b) => a + b, 0) : item.count,
    totalMs: isSql ? Math.round(item.totalMs * 1000) / 1000 : item.totalMs,
    maxMs: item.maxMs,
    lastMs: item.lastMs,
    lastTs: item.lastTs,
    hist: item.hist,
    sample: item.sample,
    source: item.source ?? 'mongodb',
    collection: item.collection ?? item.model,
  };
  if (!isSql) return wire;

  if (item.orm !== undefined) wire.orm = item.orm;
  if (item.database !== undefined) wire.database = item.database;
  if (item.sql !== undefined) wire.sql = item.sql;
  wire.errors = item.errors ?? 0;
  if (fine) wire.histFine = fine;
  if (item.codeCounts && item.codeCounts.size > 0) {
    wire.errorCodes = [...item.codeCounts]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .slice(0, MAX_ERROR_CODES);
  }
  if (item.sampleRate !== undefined && item.sampleRate < 1) wire.sampleRate = item.sampleRate;
  return wire;
}
