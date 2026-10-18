import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '../app/api/auth/password-request/route';

const WEB = 'https://qa.example.com';
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  process.env.API_ORIGIN = 'https://api.example.com';
  process.env.WEB_ORIGIN = WEB;
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WEB_ORIGIN;
});

const request = (body = JSON.stringify({ email: 'a@b.com' })) => new Request('http://0.0.0.0:3000/api/auth/password-request', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: WEB },
  body,
});

describe('POST /api/auth/password-request', () => {
  it('forwards the body to /v1/auth/password/request as JSON', async () => {
    const fn = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response('{"status":"sent"}', { status: 202 }));
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    await POST(request());
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example.com/v1/auth/password/request');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ email: 'a@b.com' }));
  });

  // Anti-enumeration: the reply must be identical whatever happened upstream.
  it.each([
    ['202 (the normal case)', async () => new Response('{"status":"sent"}', { status: 202 })],
    ['400 (malformed email)', async () => new Response('{"error":"invalid body"}', { status: 400 })],
    ['429 (rate limited)', async () => new Response('{"error":"Too Many Requests"}', { status: 429 })],
    ['500', async () => new Response('{"error":"Internal Server Error"}', { status: 500 })],
    ['a network failure', async () => { throw new TypeError('fetch failed'); }],
  ])('answers the same neutral 202 when upstream gives %s', async (_label, impl) => {
    globalThis.fetch = vi.fn(impl) as unknown as typeof globalThis.fetch;
    const res = await POST(request());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'sent' });
  });
});
