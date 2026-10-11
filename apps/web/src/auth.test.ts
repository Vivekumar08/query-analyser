import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cookieStore = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieStore.has(n) ? { name: n, value: cookieStore.get(n)! } : undefined),
  }),
}));

const redirectCalls: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    throw new Error('NEXT_REDIRECT');
  },
}));

import { getSession, requireSession } from './auth.js';

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  cookieStore.clear();
  redirectCalls.length = 0;
  process.env.API_ORIGIN = 'https://api.example.com';
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const meOk = () => {
  globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify({
      id: 'u1', email: 'a@b.io', name: 'A', isPlatformAdmin: false, emailVerifiedAt: null,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof globalThis.fetch;
};

describe('getSession', () => {
  it('returns null when there is no session cookie, without calling the API', async () => {
    const fn = vi.fn();
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    expect(await getSession()).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns the user when the session cookie is valid', async () => {
    cookieStore.set('qa_session', 'tok');
    meOk();
    const s = await getSession();
    expect(s?.user.email).toBe('a@b.io');
    expect(s?.accessToken).toBe('tok');
  });

  it('returns null when the API rejects the token', async () => {
    cookieStore.set('qa_session', 'stale');
    globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ error: 'unauthorized' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch;
    expect(await getSession()).toBeNull();
  });

  it('throws rather than returning null when the API fails with something other than 401', async () => {
    // A 500 or a network error means the API is unreachable or broken — not
    // that the token is bad. Treating it like a 401 would send the caller
    // straight into requireSession's refresh redirect on every retry,
    // rotating a real refresh token each time for no reason. This must
    // surface as a real failure instead of being silently reinterpreted as
    // "no session".
    cookieStore.set('qa_session', 'tok');
    globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ error: 'boom' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch;
    await expect(getSession()).rejects.toThrow('session check failed with status 500');
  });
});

describe('requireSession', () => {
  it('redirects to the refresh route (not /login) when there is no session', async () => {
    // THE GATE. A missing session cookie is indistinguishable from one that
    // just aged out (maxAge == token lifetime, so the browser sends nothing
    // either way). Only the refresh handler can tell the difference, because
    // it is the only path the refresh cookie is scoped to. If this redirects
    // straight to /login instead, every dashboard page logs a valid session
    // out every 15 minutes.
    await expect(requireSession('/dashboard')).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectCalls[0]).toBe('/api/auth/refresh?next=%2Fdashboard');
  });

  it('returns the session when one exists, without redirecting', async () => {
    cookieStore.set('qa_session', 'tok');
    meOk();
    const s = await requireSession('/dashboard');
    expect(s.user.id).toBe('u1');
    expect(redirectCalls).toHaveLength(0);
  });

  it('never puts the access token in the returned user object', async () => {
    // The user object is what pages pass to client components. If the token
    // rode along inside it, it would be serialised into the RSC payload and
    // end up readable in the browser — defeating the httpOnly cookie.
    cookieStore.set('qa_session', 'tok');
    meOk();
    const s = await requireSession('/dashboard');
    expect(JSON.stringify(s.user)).not.toContain('tok');
  });
});
