import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * End-to-end through the real pieces: requireSession() -> refresh handler ->
 * retried page -> requireSession() -> refresh handler. A simulated browser
 * jar applies every Set-Cookie the handler emits, so the one-hop guard is
 * exercised the way a browser would carry it — not by a test pre-seeding the
 * marker by hand.
 */

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
  }),
}));

const redirectCalls: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    throw new Error('NEXT_REDIRECT');
  },
}));

import { requireSession } from './auth';
import { GET } from '../app/api/auth/refresh/route';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

const WEB = 'https://web.example.com';

/** Applies Set-Cookie headers to the simulated browser jar (Max-Age=0 deletes). */
function applySetCookies(res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(';').map((p) => p.trim());
    const eq = pair!.indexOf('=');
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    const expired = attrs.some((a) => /^max-age=0$/i.test(a));
    if (expired) jar.delete(name);
    else jar.set(name, value);
  }
}

/** A page render: returns the redirect target requireSession() chose. */
async function renderPage(path: string): Promise<string> {
  redirectCalls.length = 0;
  await expect(requireSession(path)).rejects.toThrow('NEXT_REDIRECT');
  return redirectCalls[0]!;
}

async function hitRefresh(location: string): Promise<Response> {
  const res = await GET(new Request(`${WEB}${location}`));
  applySetCookies(res);
  return res;
}

let originalFetch: typeof globalThis.fetch;
let refreshCalls = 0;
beforeEach(() => {
  jar.clear();
  refreshCalls = 0;
  process.env.API_ORIGIN = 'https://api.example.com';
  originalFetch = globalThis.fetch;
  // /v1/auth/refresh always succeeds and rotates; /v1/me always 401s — the
  // pathological "freshly minted token is still rejected" case that used to
  // ping-pong forever.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.endsWith('/v1/auth/refresh')) {
      refreshCalls += 1;
      return new Response(JSON.stringify({ accessToken: `access-${refreshCalls}` }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': `qa_refresh=rot-${refreshCalls}; Path=/v1/auth; HttpOnly; Secure`,
        },
      });
    }
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('refresh round trip', () => {
  it('rotates once, returns to next, and on a second failing hop goes to /login and clears the marker', async () => {
    jar.set('qa_refresh', 'orig');

    // Hop 1: no session -> refresh handler (B5: not /login).
    const first = await renderPage('/dashboard?tab=queries');
    expect(first).toBe('/api/auth/refresh?next=%2Fdashboard%3Ftab%3Dqueries');

    const r1 = await hitRefresh(first);
    expect(r1.headers.get('location')).toBe(`/dashboard?tab=queries`);
    expect(refreshCalls).toBe(1);
    expect(jar.get('qa_session')).toBe('access-1');
    expect(jar.get('qa_refresh')).toBe('rot-1');
    expect(jar.get('qa_refresh_attempt')).toBe('1');

    // The retried page still cannot use its session (/v1/me 401s) — so it
    // redirects to refresh again. The caller passed only its path; the
    // bound must hold regardless of what the caller put in the URL.
    const second = await renderPage('/dashboard?tab=queries');
    expect(second).toBe('/api/auth/refresh?next=%2Fdashboard%3Ftab%3Dqueries');

    // Hop 2: marker present -> stop.
    const r2 = await hitRefresh(second);
    expect(r2.headers.get('location')).toBe(`/login?next=%2Fdashboard%3Ftab%3Dqueries`);
    expect(refreshCalls).toBe(1);
    expect(jar.has('qa_refresh_attempt')).toBe(false);
  });

  it('a later visit after the marker is gone refreshes normally (no sticky logout)', async () => {
    // The old URL marker stuck in the address bar and logged a valid user
    // out on reload. A bookmark carrying a stale r=1 must be harmless.
    jar.set('qa_refresh', 'orig');
    const loc = await renderPage('/dashboard?r=1');
    const res = await hitRefresh(loc);
    expect(res.headers.get('location')).toBe(`/dashboard?r=1`);
    expect(refreshCalls).toBe(1);
  });

  it('from the proxy: an expired qa_session with a live refresh token comes back to the same page, not /login', async () => {
    // B14: the proxy runs before requireSession, so it too must defer to the
    // refresh handler rather than deciding "logged out" on its own.
    jar.set('qa_refresh', 'orig');
    const p = proxy(new NextRequest(`${WEB}/dashboard?tab=queries`));
    const loc = new URL(p.headers.get('location')!, WEB);
    const res = await hitRefresh(loc.pathname + loc.search);
    expect(res.headers.get('location')).toBe(`/dashboard?tab=queries`);
    expect(refreshCalls).toBe(1);
    expect(jar.get('qa_session')).toBe('access-1');
  });

  it('from the proxy: a visitor with no refresh cookie ends at /login carrying the original path and query', async () => {
    // B15: after logging in they must land where they asked to go.
    const p = proxy(new NextRequest(`${WEB}/dashboard/q?tab=slow&page=2`));
    const loc = new URL(p.headers.get('location')!, WEB);
    const res = await hitRefresh(loc.pathname + loc.search);
    const login = new URL(res.headers.get('location')!, WEB);
    expect(login.origin + login.pathname).toBe(`${WEB}/login`);
    expect(login.searchParams.get('next')).toBe('/dashboard/q?tab=slow&page=2');
    expect(refreshCalls).toBe(0);
  });
});
