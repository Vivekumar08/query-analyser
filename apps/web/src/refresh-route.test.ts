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

/**
 * A real success Response, not a bare `vi.fn()`. A mutation that bypasses a
 * guard upstream of the fetch call must then fail on the handler's actual
 * redirect/cookie assertions, not crash inside `singleFlight` with a
 * TypeError — an incidental failure proves nothing about the guard itself.
 */
function successFetchMock() {
  return vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify({ accessToken: 'newtok' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
}

describe('GET /api/auth/refresh', () => {
  describe('the one-hop loop guard (qa_refresh_attempt cookie)', () => {
    it('on a second hop (marker present): redirects to /login, clears the marker, and does not call the API', async () => {
      // EXACTLY ONCE. The marker is set by the previous successful rotation;
      // arriving with it means the retried page still had no usable session.
      // Rotating again would loop, burning a real refresh token per bounce.
      const fn = successFetchMock();
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;
      cookieStore.set('qa_refresh', 'sometoken');
      cookieStore.set('qa_refresh_attempt', '1');

      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://web.example.com/login');
      expect(fn).not.toHaveBeenCalled();
      const marker = res.headers.getSetCookie().find((c) => c.startsWith('qa_refresh_attempt='));
      expect(marker).toBeDefined();
      expect(marker).toMatch(/^qa_refresh_attempt=;/);
      expect(marker).toContain('Path=/api/auth');
      expect(marker).toContain('Max-Age=0');
    });

    it('on a first hop (no marker): rotates and sets the marker, HttpOnly, scoped to /api/auth, 30s', async () => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = successFetchMock() as unknown as typeof globalThis.fetch;

      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('https://web.example.com/dashboard');
      const marker = res.headers.getSetCookie().find((c) => c.startsWith('qa_refresh_attempt='));
      expect(marker).toBeDefined();
      expect(marker).toMatch(/^qa_refresh_attempt=1;/);
      expect(marker).toContain('Path=/api/auth');
      expect(marker).toContain('Max-Age=30');
      expect(marker).toContain('HttpOnly');
      expect(marker?.toLowerCase()).toContain('samesite=lax');
    });

    it('puts no marker in the redirect URL (nothing for history or a bookmark to replay)', async () => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = successFetchMock() as unknown as typeof globalThis.fetch;
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard%3Fr%3D1'));
      // A stale `r=1` from an old bookmark is just an ordinary query param now.
      expect(res.headers.get('location')).toBe('https://web.example.com/dashboard?r=1');
      const res2 = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res2.headers.get('location')).toBe('https://web.example.com/dashboard');
    });

    it('does not set the marker when the refresh fails', async () => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('https://web.example.com/login');
      expect(res.headers.getSetCookie().some((c) => c.startsWith('qa_refresh_attempt=1'))).toBe(false);
    });
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
      globalThis.fetch = successFetchMock() as unknown as typeof globalThis.fetch;
    });

    it('rejects a protocol-relative next (//evil.com) and falls back to /', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2F%2Fevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('https://web.example.com/');
    });

    it('rejects an absolute next (https://evil.com) and falls back to /', async () => {
      const res = await GET(req('/api/auth/refresh?next=https%3A%2F%2Fevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('https://web.example.com/');
    });

    it('rejects a backslash-prefixed next (/\\evil.com) and falls back to /', async () => {
      // WHATWG URL parsing normalises a leading backslash to a slash for
      // special schemes, so `new URL('/\\evil.com', origin)` resolves to
      // `https://evil.com/` — a prefix check like `startsWith('/')` alone
      // cannot see this. Verified directly against the WHATWG URL parser.
      const res = await GET(req('/api/auth/refresh?next=%2F%5Cevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('https://web.example.com/');
    });

    it.each([
      '/.//evil.com',
      '/..//evil.com',
      '/a/..//evil.com',
      '/%2e//evil.com',
      '/%2e%2e//evil.com',
      '/./\\evil.com',
    ])('rejects the dot-segment bypass %s and stays on origin', async (raw) => {
      // These resolve SAME-origin with a pathname of `//evil.com`; re-parsing
      // that pathname as a string would make it protocol-relative.
      const res = await GET(req(`/api/auth/refresh?next=${encodeURIComponent(raw)}`));
      const location = res.headers.get('location') ?? '';
      expect(new URL(location).origin).toBe('https://web.example.com');
      expect(location).toBe('https://web.example.com/');
    });

    it('accepts a same-origin absolute path', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('https://web.example.com/dashboard');
    });

    it('preserves an existing query string on next when building the retry URL', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard%3Ffoo%3Dbar'));
      expect(res.headers.get('location')).toBe('https://web.example.com/dashboard?foo=bar');
    });
  });

  describe('cookie forwarding on a successful refresh', () => {
    beforeEach(() => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({ accessToken: 'newtok' }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'qa_refresh=rotated; Path=/v1/auth; HttpOnly; Secure',
          },
        },
      )) as unknown as typeof globalThis.fetch;
    });

    it('sets qa_session and forwards the rotated qa_refresh cookie, rescoped to /api/auth', async () => {
      // If either write is missing, the next refresh either has no access
      // token (qa_session) or presents the already-consumed refresh token
      // (qa_refresh) and the API revokes the whole family — a silent logout.
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      const all = res.headers.getSetCookie();

      expect(all.some((c) => c.startsWith('qa_session='))).toBe(true);
      const refreshCookie = all.find((c) => c.startsWith('qa_refresh='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toContain('rotated');
      expect(refreshCookie).toContain('Path=/api/auth');
    });
  });

  describe('upstream response guarding', () => {
    beforeEach(() => {
      cookieStore.set('qa_refresh', 'sometoken');
    });

    it('redirects to /login when the upstream body is not valid JSON', async () => {
      globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
        'not json', { status: 200 },
      )) as unknown as typeof globalThis.fetch;
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('https://web.example.com/login');
    });

    it('redirects to /login when the upstream 200 omits accessToken', async () => {
      globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('https://web.example.com/login');
    });
  });
});
