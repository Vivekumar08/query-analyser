import { gzipSync } from 'node:zlib';
import type { IngestItem, IngestPayload } from './types.js';

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

/**
 * Largest serialised (pre-gzip) JSON body one POST may carry. The ingest API
 * limits the *decompressed* body to 2 MiB; 1.5 MiB leaves headroom.
 */
export const MAX_CHUNK_BYTES = 1_572_864;

/**
 * Splits one flush's items into POST-sized chunks (greedy, in order), each of
 * whose JSON body `{...base, items}` is at most `maxBytes`. Item sizes are
 * measured once with JSON.stringify, and a body is exactly the base payload
 * plus the items joined by commas, so the bound is exact.
 *
 * An item that cannot fit even alone first loses its `encryptedSample` (set
 * to `null` in place); if it still does not fit it is listed in `oversized`
 * and left out. An empty batch is one empty chunk, so a drop count is still
 * reported.
 */
export function planChunks(
  base: Omit<IngestPayload, 'items'>,
  items: IngestItem[],
  maxBytes: number = MAX_CHUNK_BYTES,
): { chunks: number[][]; oversized: number[] } {
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...base, items: [] }));
  const sizeOf = (item: IngestItem) => Buffer.byteLength(JSON.stringify(item));
  const chunks: number[][] = [];
  const oversized: number[] = [];
  let current: number[] = [];
  let currentBytes = baseBytes;

  items.forEach((item, i) => {
    let size = sizeOf(item);
    if (baseBytes + size > maxBytes && item.encryptedSample) {
      item.encryptedSample = null;
      size = sizeOf(item);
    }
    if (baseBytes + size > maxBytes) {
      oversized.push(i);
      return;
    }
    // A comma separates this item from the previous one in the same chunk.
    const added = current.length === 0 ? size : size + 1;
    if (currentBytes + added > maxBytes) {
      chunks.push(current);
      current = [i];
      currentBytes = baseBytes + size;
    } else {
      current.push(i);
      currentBytes += added;
    }
  });
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return { chunks, oversized };
}
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
