import { describe, it, expect, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createTransport } from './transport.js';
import type { IngestPayload } from '@query-analyser/contract/runtime';

const payload: IngestPayload = {
  app: 'test-app', env: 'test', host: 'h', sdkVersion: '0.1.0',
  bucket: '2026092014', thresholdMs: 100, dropped: 0,
  items: [{
    signature: 'Order.find(status:eq)', hash: 'a'.repeat(16), model: 'Order', operation: 'find',
    filterShape: [{ key: 'status', op: 'eq' }], sortKeys: [], stages: [],
    count: 1, totalMs: 120, maxMs: 120, lastMs: 120, lastTs: 1, hist: [1,0,0,0,0,0,0,0],
    sample: { status: '<string>' },
  }],
};

const ok = (): Promise<Response> => Promise.resolve(new Response('{}', { status: 202 }));

describe('transport', () => {
  it('posts JSON with a bearer token', async () => {
    const fetchImpl = vi.fn(ok);
    const t = createTransport({ endpoint: 'https://x/v1/ingest', apiKey: 'qa_live_k', fetchImpl });
    expect(await t.send(payload)).toEqual({ status: 'ok' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x/v1/ingest');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer qa_live_k');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('gzips bodies over 1KB and marks the encoding', async () => {
    const fetchImpl = vi.fn(ok);
    const big = { ...payload, items: Array.from({ length: 50 }, () => payload.items[0]!) };
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    await t.send(big);

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const init = call[1]!;
    expect((init.headers as Record<string, string>)['Content-Encoding']).toBe('gzip');
    const sent = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8'));
    expect(sent.items).toHaveLength(50);
  });

  it('treats 401 as permanently disabled', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('bad key', { status: 401 })));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toMatchObject({ status: 'disabled' });
  });

  it('treats 403 as permanently disabled', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('revoked', { status: 403 })));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toMatchObject({ status: 'disabled' });
  });

  it('honours Retry-After on 429', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('slow down', {
      status: 429, headers: { 'Retry-After': '30' },
    })));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toEqual({ status: 'retry', afterMs: 30_000 });
  });

  it('retries on a 5xx', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('boom', { status: 503 })));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toMatchObject({ status: 'retry' });
  });

  it('drops the batch on a 400 rather than retrying a body the server will never accept', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('invalid', { status: 400 })));
    const onError = vi.fn();
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl, onError });
    expect(await t.send(payload)).toEqual({ status: 'ok' });
    expect(onError).toHaveBeenCalled();
  });

  it('retries when the network throws, and reports the error', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const onError = vi.fn();
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl, onError });
    expect(await t.send(payload)).toMatchObject({ status: 'retry' });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('returns ok and reports when payload cannot be serialized (e.g. BigInt)', async () => {
    const fetchImpl = vi.fn(ok);
    const onError = vi.fn();
    const badPayload: IngestPayload = {
      ...payload,
      items: [{
        ...payload.items[0]!,
        sample: { n: 10n },
      }],
    };
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl, onError });
    const result = await t.send(badPayload);
    expect(result).toEqual({ status: 'ok' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]!.message).toMatch(/serialize|JSON/);
  });

  it('handles 429 without Retry-After header', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('slow down', {
      status: 429,
    })));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toEqual({ status: 'retry', afterMs: 5000 });
  });

  it('ignores HTTP-date form Retry-After on 429', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('slow down', {
      status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    })));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toEqual({ status: 'retry', afterMs: 5000 });
  });

  it('times out and retries with error reporting', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => {
        const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
        reject(err);
      });
    }));
    const onError = vi.fn();
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl, timeoutMs: 10, onError });
    const result = await t.send(payload);
    expect(result).toEqual({ status: 'retry', afterMs: 5000 });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0]![0]!.message).toMatch(/timed out after 10ms/);
  });

  it('does not reject when onError throws', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const onError = vi.fn(() => { throw new Error('oops'); });
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl, onError });
    const result = await t.send(payload);
    expect(result).toEqual({ status: 'retry', afterMs: 5000 });
    expect(onError).toHaveBeenCalled();
  });
});
