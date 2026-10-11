import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, apiOrigin, authedFetch } from './api.js';

const ORIGIN = 'https://api.example.com';
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  process.env.API_ORIGIN = ORIGIN;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mockFetch = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const fn = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  }));
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
};

describe('apiOrigin', () => {
  it('reads the environment on every call, never at module scope', () => {
    // The Dockerfile sets API_ORIGIN=https://placeholder.invalid at BUILD
    // time. A module-scope read would capture the placeholder and bake it
    // into every statically prerendered payload.
    expect(apiOrigin()).toBe(ORIGIN);
    process.env.API_ORIGIN = 'https://other.example.com';
    expect(apiOrigin()).toBe('https://other.example.com');
  });
});

describe('apiFetch', () => {
  it('returns ok with parsed data on 200', async () => {
    mockFetch(200, { id: 'u1' });
    const res = await apiFetch<{ id: string }>('/v1/me');
    expect(res).toEqual({ ok: true, data: { id: 'u1' } });
  });

  it('attaches the bearer token when one is given, and omits it otherwise', async () => {
    const fn = mockFetch(200, {});
    await apiFetch('/v1/me', undefined, 'tok123');
    const withTok = new Headers((fn.mock.calls[0]![1] as RequestInit).headers);
    expect(withTok.get('authorization')).toBe('Bearer tok123');

    const fn2 = mockFetch(200, {});
    await apiFetch('/v1/me');
    const without = new Headers((fn2.mock.calls[0]![1] as RequestInit).headers);
    expect(without.has('authorization')).toBe(false);
  });

  it('surfaces the machine-readable code on a 403, not just the message', async () => {
    // The gate returns {"error":"email not verified","code":"email_not_verified"}.
    // Guards branch on `code`; the prose message may be reworded at any time.
    mockFetch(403, { error: 'email not verified', code: 'email_not_verified' });
    const res = await apiFetch('/v1/orgs');
    expect(res).toEqual({
      ok: false, status: 403, code: 'email_not_verified', error: 'email not verified',
    });
  });

  it('returns a failure result on 401 rather than throwing', async () => {
    // Callers branch on this to trigger the refresh redirect. A thrown error
    // would surface as a 500 page instead of a silent token rotation.
    mockFetch(401, { error: 'unauthorized' });
    const res = await apiFetch('/v1/me');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('never caches an authenticated response', async () => {
    // Next caches fetches by default. A cached /v1/me would serve one user's
    // identity to another.
    const fn = mockFetch(200, {});
    await apiFetch('/v1/me', undefined, 'tok');
    expect((fn.mock.calls[0]![1] as RequestInit & { cache?: string }).cache).toBe('no-store');
  });

  it('survives a non-JSON error body without throwing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>502</html>', {
      status: 502, headers: { 'content-type': 'text/html' },
    })) as unknown as typeof globalThis.fetch;
    const res = await apiFetch('/v1/me');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
  });

  it('returns a failure result when the body cannot be read', async () => {
    // A response whose body rejects mid-read. apiFetch must not throw —
    // every caller branches on the result and none of them has a catch.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error('aborted')),
    })) as unknown as typeof globalThis.fetch;
    const res = await apiFetch('/v1/me');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(200);
  });

  it('returns ok with no data on a 204/empty body', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    const res = await apiFetch('/v1/me');
    expect(res).toEqual({ ok: true, data: undefined });
  });

  it('survives an error body that is valid JSON but not an object', async () => {
    mockFetch(500, 'just a string');
    const res = await apiFetch('/v1/me');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(500);
      expect(res.code).toBeUndefined();
      expect(res.error).toBe('request failed with 500');
    }
  });
});

describe('authedFetch', () => {
  it('always attaches the bearer token', async () => {
    const fn = mockFetch(200, {});
    await authedFetch('/v1/me', 'tok456');
    const headers = new Headers((fn.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer tok456');
  });
});
