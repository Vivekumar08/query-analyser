import { gzipSync } from 'node:zlib';
import type { IngestPayload } from './types.js';

export type SendResult =
  | { status: 'ok' }
  | { status: 'retry'; afterMs: number }
  | { status: 'disabled'; reason: string };

export interface TransportOptions {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (err: Error) => void;
}

export interface Transport {
  send(payload: IngestPayload): Promise<SendResult>;
}

const GZIP_THRESHOLD_BYTES = 1024;
const DEFAULT_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;
const JITTER_RATIO = 0.2;

// Important 5: a flat 5s retry (below the 10s flush interval) produces an
// undamped retry storm from every customer instance during an ingest
// outage — spec §4 mandates exponential backoff up to a ceiling, and the
// README already claimed it. `consecutiveFailures` is per-Transport (one
// per init() call), incremented on every retry-worthy failure and reset to
// zero on a success or a `disabled` result, per the spec.
function backoffMs(consecutiveFailures: number): number {
  const base = Math.min(DEFAULT_RETRY_MS * 2 ** (consecutiveFailures - 1), MAX_RETRY_MS);
  const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1); // +/-20%
  return Math.round(Math.min(Math.max(base + jitter, 0), MAX_RETRY_MS));
}

export function createTransport(opts: TransportOptions): Transport {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const report = (e: Error) => { try { opts.onError?.(e); } catch { /* never throw from reporting */ } };
  let consecutiveFailures = 0;

  return {
    async send(payload) {
      let timer: NodeJS.Timeout | undefined;

      try {
        // Serialize and compress; if this fails, the batch is unserviceable — drop it.
        let json: string;
        try {
          json = JSON.stringify(payload);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          report(error);
          return { status: 'ok' };
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        };

        let body: string | Buffer = json;
        if (Buffer.byteLength(json) > GZIP_THRESHOLD_BYTES) {
          try {
            body = gzipSync(json);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            report(error);
            return { status: 'ok' };
          }
          headers['Content-Encoding'] = 'gzip';
        }

        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeoutMs);

        const res = await doFetch(opts.endpoint, {
          method: 'POST', headers, body, signal: controller.signal,
        });

        if (res.ok) { consecutiveFailures = 0; return { status: 'ok' }; }

        if (res.status === 401 || res.status === 403) {
          consecutiveFailures = 0;
          return { status: 'disabled', reason: `ingest rejected the API key (HTTP ${res.status})` };
        }

        if (res.status === 429) {
          // Important 5: an explicit Retry-After still wins over our own
          // backoff computation — the server knows its own recovery time
          // better than we do. Only the header-less case falls through to
          // exponential backoff.
          const header = res.headers.get('Retry-After');
          if (header) {
            const afterMs = Number(header) * 1000;
            return { status: 'retry', afterMs: Number.isFinite(afterMs) ? afterMs : backoffMs(++consecutiveFailures) };
          }
          return { status: 'retry', afterMs: backoffMs(++consecutiveFailures) };
        }

        if (res.status >= 400 && res.status < 500) {
          // The server will never accept this body. Drop it; keeping it would
          // block the buffer forever.
          report(new Error(`ingest rejected the batch (HTTP ${res.status})`));
          return { status: 'ok' };
        }

        return { status: 'retry', afterMs: backoffMs(++consecutiveFailures) };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          report(new Error(`ingest request timed out after ${timeoutMs}ms`));
        } else {
          report(error);
        }
        return { status: 'retry', afterMs: backoffMs(++consecutiveFailures) };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
