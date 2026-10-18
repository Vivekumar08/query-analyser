import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cookieStore = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieStore.has(n) ? { name: n, value: cookieStore.get(n)! } : undefined),
  }),
}));

import { POST as loginPost } from '../app/api/auth/login/route';
import { POST as signupPost } from '../app/api/auth/signup/route';
import { POST as logoutPost } from '../app/api/auth/logout/route';
import { POST as verifyPost } from '../app/api/auth/verify/route';
import { POST as resetPost } from '../app/api/auth/reset/route';
import { POST as passwordRequestPost } from '../app/api/auth/password-request/route';
import { GET as refreshGet } from '../app/api/auth/refresh/route';

/**
 * Ruling B20 at the route level: EVERY upstream auth call carries the
 * browser's IP and the proxy secret. A handler that skips the helper silently
 * puts its route back in the single global rate-limit bucket.
 */
const WEB = 'https://qa.example.com';
const SECRET = 'p'.repeat(40);
let originalFetch: typeof globalThis.fetch;
let seen: Headers[];

beforeEach(() => {
  cookieStore.clear();
  process.env.API_ORIGIN = 'https://api.example.com';
  process.env.WEB_ORIGIN = WEB;
  process.env.WEB_PROXY_SECRET = SECRET;
  originalFetch = globalThis.fetch;
  seen = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ accessToken: 'tok' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WEB_ORIGIN;
  delete process.env.WEB_PROXY_SECRET;
});

const browserHeaders = {
  'content-type': 'application/json',
  origin: WEB,
  'x-forwarded-for': '203.0.113.9, 10.0.0.2',
};
const post = (name: string) => new Request(`http://0.0.0.0:3000/api/auth/${name}`, {
  method: 'POST', headers: browserHeaders, body: '{"email":"a@b.com","password":"x","token":"t"}',
});

describe.each([
  ['login', () => loginPost(post('login'))],
  ['signup', () => signupPost(post('signup'))],
  ['logout', () => logoutPost(post('logout'))],
  ['verify', () => verifyPost(post('verify'))],
  ['reset', () => resetPost(post('reset'))],
  ['password-request', () => passwordRequestPost(post('password-request'))],
  ['refresh', () => {
    // A unique token per run: the refresh handler single-flights on it.
    cookieStore.set('qa_refresh', `tok-${Math.random()}`);
    return refreshGet(new Request('http://0.0.0.0:3000/api/auth/refresh?next=%2Fdashboard', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
    }));
  }],
] as const)('%s', (_name, call) => {
  it('sends x-qa-client-ip (first X-Forwarded-For hop) and x-qa-proxy-secret upstream', async () => {
    await call();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get('x-qa-client-ip')).toBe('203.0.113.9');
    expect(seen[0]!.get('x-qa-proxy-secret')).toBe(SECRET);
  });
});
