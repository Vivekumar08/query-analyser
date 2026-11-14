import type { Aggregator, SqlStatement } from '../aggregator.js';
import { createFingerprinter, maskName, type MaskKey } from './fingerprint.js';
import type { Labels } from './context.js';

export interface StatementEvent {
  text: string;
  database: string | null;
  durationMs: number;
  failed: boolean;
  errorCode: string | null;
  labels: Labels | null;
}

export interface SqlSink { record(ev: StatementEvent): void }

export interface SqlSinkOptions {
  aggregator: Aggregator;
  thresholdMs: number;
  sampleRate: number;
  maskIdentifiers: boolean;
  /** Keys identifier masking; init() passes sha256('qa-mask:' + apiKey). */
  maskKey?: MaskKey;
  isDisabled(): boolean;
  onError(e: Error): void;
  random?: () => number;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** `err.code` when it is a five-character SQLSTATE (Decision 12). Reads nothing else. */
export function sqlStateOf(err: unknown): string | null {
  try {
    if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return null;
    const code: unknown = (err as { code?: unknown }).code;
    return typeof code === 'string' && SQLSTATE.test(code) ? code : null;
  } catch {
    return null;
  }
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * The SQL core: turns one raw statement event into a weighted, labelled SqlStatement.
 * `record` never throws; failures (including invalid configuration) go to `onError`.
 */
export function createSqlSink(o: SqlSinkOptions): SqlSink {
  const { aggregator, thresholdMs, sampleRate, maskIdentifiers, maskKey } = o;
  const random = o.random ?? Math.random;
  const fingerprint = createFingerprinter({ maskIdentifiers, maskKey });
  const report = (e: unknown): void => {
    try { o.onError(toError(e)); } catch { /* onError is guarded */ }
  };

  return {
    record(ev: StatementEvent): void {
      try {
        if (o.isDisabled()) return;
        if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || !(sampleRate > 0) || sampleRate > 1) {
          throw new Error(`query-analyser: invalid sql.sampleRate ${String(sampleRate)}; expected 0 < r <= 1`);
        }
        const ms = ev.durationMs;
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
          throw new Error(`query-analyser: invalid statement duration ${String(ms)}`);
        }

        const failed = ev.failed === true;
        const slow = ms >= thresholdMs;
        let weight = 1;
        if (!slow && !failed && sampleRate < 1) {
          if (!(random() < sampleRate)) return;
          weight = 1 / sampleRate;
          if (!Number.isFinite(weight) || weight < 1) {
            throw new Error(`query-analyser: sql.sampleRate ${String(sampleRate)} gives an invalid weight`);
          }
        }

        const fp = fingerprint(ev.text);
        if (fp === null) return;

        const labels = ev.labels;
        const labelModel = labels?.model ?? null;
        let model: string;
        if (labelModel !== null) model = maskIdentifiers ? maskName(labelModel, maskKey) : labelModel;
        else model = fp.table ?? '(sql)';
        const operation = labels?.operation ?? fp.verb;
        const database = ev.database === null || ev.database === undefined
          ? undefined
          : (maskIdentifiers ? maskName(ev.database, maskKey) : ev.database).slice(0, 255);
        const code = failed && typeof ev.errorCode === 'string' && SQLSTATE.test(ev.errorCode) ? ev.errorCode : null;

        const st: SqlStatement = {
          hash: fp.hash,
          signature: fp.sql.slice(0, 400),
          model: model.slice(0, 200),
          operation: operation.slice(0, 40),
          table: fp.table,
          ...(labels?.orm !== undefined ? { orm: labels.orm } : {}),
          ...(database !== undefined ? { database } : {}),
          sql: fp.sql,
          durationMs: ms,
          slow,
          weight,
          failed,
          errorCode: code,
          sampleRate,
        };
        aggregator.addStatement(st);
      } catch (e) {
        report(e);
      }
    },
  };
}
