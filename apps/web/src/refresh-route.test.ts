import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cookieStore = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieStore.has(n) ? { name: n, value: cookieStore.get(n)! } : undefined),
  }),
}));

import { GET } from '../app/api/auth/refresh/route.js';

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  cookieStore.clear();
  process.env.API_ORIGIN = 'https://api.example.com';
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function req(path: string): Request {
  return new Request(`https://web.example.com${path}`);
}

describe('GET /api/auth/refresh', () => {
  it('redirects to /login when r=1 is already present, without calling the upstream API', async () => {
    // EXACTLY ONCE. This is what stops a failing refresh from bouncing the
    // visitor between the dashboard and this route forever.
    const fn = vi.fn();
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    cookieStore.set('qa_refresh', 'sometoken');

    const res = await GET(req('/api/auth/refresh?next=%2Fdashboard&r=1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://web.example.com/login');
    expect(fn).not.toHaveBeenCalled();
  });

  it('redirects to /login when the refresh cookie is missing', async () => {
    // The genuinely-logged-out case: no refresh token to recover with.
    const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://web.example.com/login');
  });

  describe('the next= open-redirect guard', () => {
    beforeEach(() => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({ accessToken: 'newtok' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
    });

    it('rejects a protocol-relative next (//evil.com) and falls back to /', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2F%2Fevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('https://web.example.com/?r=1');
    });

    it('rejects an absolute next (https://evil.com) and falls back to /', async () => {
      const res = await GET(req('/api/auth/refresh?next=https%3A%2F%2Fevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('https://web.example.com/?r=1');
    });

    it('accepts a same-origin absolute path', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('https://web.example.com/dashboard?r=1');
    });
  });
});
