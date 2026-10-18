import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cookieStore = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieStore.has(n) ? { name: n, value: cookieStore.get(n)! } : undefined),
  }),
}));

import { GET } from '../app/api/auth/refresh/route';

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
      expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard');
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
      expect(res.headers.get('location')).toBe('/dashboard');
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
      expect(res.headers.get('location')).toBe('/dashboard?r=1');
      const res2 = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res2.headers.get('location')).toBe('/dashboard');
    });

    it('does not set the marker when the refresh fails', async () => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard');
      expect(res.headers.getSetCookie().some((c) => c.startsWith('qa_refresh_attempt=1'))).toBe(false);
    });
  });

  describe('carrying the requested page through to /login (B15)', () => {
    it('omits next when there is none (it would validate to the default anyway)', async () => {
      const res = await GET(req('/api/auth/refresh'));
      expect(res.headers.get('location')).toBe('/login');
    });

    it('omits next when it validates to the default /', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2F'));
      expect(res.headers.get('location')).toBe('/login');
    });

    it.each(['//evil.com', 'https://evil.com', '/.//evil.com', '/%2e%2e//evil.com', '/\\evil.com'])(
      'drops a hostile next (%s) rather than carrying it to /login',
      async (raw) => {
        const res = await GET(req(`/api/auth/refresh?next=${encodeURIComponent(raw)}`));
        expect(res.headers.get('location')).toBe('/login');
      },
    );

    it('preserves path and query, encoded, on the no-refresh-cookie branch', async () => {
      const res = await GET(req(`/api/auth/refresh?next=${encodeURIComponent('/dashboard/q?tab=slow&page=2')}`));
      const location = new URL(res.headers.get('location')!, 'https://public.example');
      expect(location.pathname).toBe('/login');
      expect(location.search).toBe('?next=%2Fdashboard%2Fq%3Ftab%3Dslow%26page%3D2');
      expect(location.searchParams.get('next')).toBe('/dashboard/q?tab=slow&page=2');
    });
  });

  it('redirects to /login when the refresh cookie is missing', async () => {
    // The genuinely-logged-out case: no refresh token to recover with.
    const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard');
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
      expect(location).toBe('/');
    });

    it('rejects an absolute next (https://evil.com) and falls back to /', async () => {
      const res = await GET(req('/api/auth/refresh?next=https%3A%2F%2Fevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('/');
    });

    it('rejects a backslash-prefixed next (/\\evil.com) and falls back to /', async () => {
      // WHATWG URL parsing normalises a leading backslash to a slash for
      // special schemes, so `new URL('/\\evil.com', origin)` resolves to
      // `https://evil.com/` — a prefix check like `startsWith('/')` alone
      // cannot see this. Verified directly against the WHATWG URL parser.
      const res = await GET(req('/api/auth/refresh?next=%2F%5Cevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('/');
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
      expect(new URL(location, 'https://public.example').origin).toBe('https://public.example');
      expect(location).toBe('/');
    });

    it('accepts a same-origin absolute path', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('/dashboard');
    });

    it('preserves an existing query string on next when building the retry URL', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard%3Ffoo%3Dbar'));
      expect(res.headers.get('location')).toBe('/dashboard?foo=bar');
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
      expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard');
    });

    it('redirects to /login when the upstream 200 omits accessToken', async () => {
      globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard');
    });
  });

  describe('Location is relative, never the bind address (Ruling B18)', () => {
    // In Next's standalone server request.url is built from the HOSTNAME env
    // and PORT, not the Host header — the final review's probe saw
    // `location: https://0.0.0.0:3918/login?...`. Every exit must therefore
    // emit a bare path that the browser resolves against the public host.
    const bindReq = (path: string) => new Request(`http://0.0.0.0:3918${path}`, {
      headers: { host: 'qa.example.com', 'x-forwarded-proto': 'https' },
    });
    const assertHostFree = (location: string | null) => {
      expect(location).not.toBeNull();
      expect(location).toMatch(/^\/(?!\/)/);
      expect(location).not.toContain('0.0.0.0');
      expect(location).not.toContain('3918');
      expect(location).not.toMatch(/^[a-z]+:/i);
    };

    it('no refresh cookie: relative /login?next=…', async () => {
      const res = await GET(bindReq('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard');
      assertHostFree(res.headers.get('location'));
    });

    it('second hop (marker present): relative /login?next=…', async () => {
      cookieStore.set('qa_refresh', 'sometoken');
      cookieStore.set('qa_refresh_attempt', '1');
      const res = await GET(bindReq('/api/auth/refresh?next=%2Fdashboard'));
      assertHostFree(res.headers.get('location'));
    });

    it('upstream 401: relative /login?next=…', async () => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof globalThis.fetch;
      const res = await GET(bindReq('/api/auth/refresh?next=%2Fdashboard'));
      assertHostFree(res.headers.get('location'));
    });

    it('successful rotation: relative path back to the page', async () => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = successFetchMock() as unknown as typeof globalThis.fetch;
      const res = await GET(bindReq('/api/auth/refresh?next=%2Fdashboard%3Ftab%3Dslow'));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('/dashboard?tab=slow');
      assertHostFree(res.headers.get('location'));
    });

    it('a next naming the bind address itself is dropped, not echoed', async () => {
      cookieStore.set('qa_refresh', 'sometoken');
      globalThis.fetch = successFetchMock() as unknown as typeof globalThis.fetch;
      const res = await GET(bindReq(`/api/auth/refresh?next=${encodeURIComponent('http://0.0.0.0:3918/dashboard')}`));
      expect(res.headers.get('location')).toBe('/');
    });
  });
});
