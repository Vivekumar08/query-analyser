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
  it('redirects to /login when the next param already carries r=1, without calling the upstream API', async () => {
    // EXACTLY ONCE. The marker lives inside `next` (written there by a prior
    // successful refresh's retry redirect), not on this request's own query
    // string — a page that still has no session redirects here with a plain
    // `next`, never with its own `r=1`. Reading the marker from the wrong
    // place made this guard dead code and the whole flow an unbounded
    // rotation loop.
    const fn = successFetchMock();
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    cookieStore.set('qa_refresh', 'sometoken');

    const res = await GET(req('/api/auth/refresh?next=%2Fdashboard%3Fr%3D1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://web.example.com/login');
    expect(fn).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit on r=1 present only on this request\'s own query string', async () => {
    // Regression guard for the old (dead) check: `r=1` appearing on the
    // refresh route's own URL, rather than inside `next`, must not stop the
    // refresh — no real caller ever produces that shape, but the fix must
    // not accidentally swallow a legitimate `next` whose own query happens
    // to contain other params.
    cookieStore.set('qa_refresh', 'sometoken');
    globalThis.fetch = successFetchMock() as unknown as typeof globalThis.fetch;
    const res = await GET(req('/api/auth/refresh?next=%2Fdashboard&r=1'));
    expect(res.headers.get('location')).toBe('https://web.example.com/dashboard?r=1');
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
      expect(location).toBe('https://web.example.com/?r=1');
    });

    it('rejects an absolute next (https://evil.com) and falls back to /', async () => {
      const res = await GET(req('/api/auth/refresh?next=https%3A%2F%2Fevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('https://web.example.com/?r=1');
    });

    it('rejects a backslash-prefixed next (/\\evil.com) and falls back to /', async () => {
      // WHATWG URL parsing normalises a leading backslash to a slash for
      // special schemes, so `new URL('/\\evil.com', origin)` resolves to
      // `https://evil.com/` — a prefix check like `startsWith('/')` alone
      // cannot see this. Verified directly against the WHATWG URL parser.
      const res = await GET(req('/api/auth/refresh?next=%2F%5Cevil.com'));
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('evil.com');
      expect(location).toBe('https://web.example.com/?r=1');
    });

    it('accepts a same-origin absolute path', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard'));
      expect(res.headers.get('location')).toBe('https://web.example.com/dashboard?r=1');
    });

    it('preserves an existing query string on next when building the retry URL', async () => {
      const res = await GET(req('/api/auth/refresh?next=%2Fdashboard%3Ffoo%3Dbar'));
      expect(res.headers.get('location')).toBe('https://web.example.com/dashboard?foo=bar&r=1');
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
