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

export function createTransport(opts: TransportOptions): Transport {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const report = (e: Error) => { try { opts.onError?.(e); } catch { /* never throw from reporting */ } };

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

        if (res.ok) return { status: 'ok' };

        if (res.status === 401 || res.status === 403) {
          return { status: 'disabled', reason: `ingest rejected the API key (HTTP ${res.status})` };
        }

        if (res.status === 429) {
          const header = res.headers.get('Retry-After');
          const afterMs = header ? Number(header) * 1000 : DEFAULT_RETRY_MS;
          return { status: 'retry', afterMs: Number.isFinite(afterMs) ? afterMs : DEFAULT_RETRY_MS };
        }

        if (res.status >= 400 && res.status < 500) {
          // The server will never accept this body. Drop it; keeping it would
          // block the buffer forever.
          report(new Error(`ingest rejected the batch (HTTP ${res.status})`));
          return { status: 'ok' };
        }

        return { status: 'retry', afterMs: DEFAULT_RETRY_MS };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          report(new Error(`ingest request timed out after ${timeoutMs}ms`));
        } else {
          report(error);
        }
        return { status: 'retry', afterMs: DEFAULT_RETRY_MS };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
