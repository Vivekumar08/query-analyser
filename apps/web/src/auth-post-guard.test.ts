import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { POST as loginPost } from '../app/api/auth/login/route';
import { POST as signupPost } from '../app/api/auth/signup/route';
import { POST as logoutPost } from '../app/api/auth/logout/route';
import { POST as verifyPost } from '../app/api/auth/verify/route';
import { POST as resetPost } from '../app/api/auth/reset/route';
import { POST as passwordRequestPost } from '../app/api/auth/password-request/route';

/**
 * Pins Ruling B19 at the route level: every auth POST handler runs the guard
 * BEFORE anything reaches the API. A guard that exists but is not called by a
 * route is the failure this file is here to catch.
 */
const WEB = 'https://qa.example.com';
let originalFetch: typeof globalThis.fetch;
let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.API_ORIGIN = 'https://api.example.com';
  process.env.WEB_ORIGIN = WEB;
  originalFetch = globalThis.fetch;
  upstream = vi.fn(async () => new Response(JSON.stringify({ accessToken: 'tok' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WEB_ORIGIN;
});

const handlers = [
  ['login', loginPost],
  ['signup', signupPost],
  ['logout', logoutPost],
  ['verify', verifyPost],
  ['reset', resetPost],
  ['password-request', passwordRequestPost],
] as const;

function post(name: string, headers: Record<string, string>, body = '{"email":"a@b.com","password":"x"}'): Request {
  return new Request(`http://0.0.0.0:3000/api/auth/${name}`, { method: 'POST', headers, body });
}

describe.each(handlers)('POST /api/auth/%s', (name, handler) => {
  it('rejects a cross-site text/plain form post with 403 and never calls the API', async () => {
    const res = await handler(post(name, { 'content-type': 'text/plain', origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects a same-origin text/plain post with 403', async () => {
    const res = await handler(post(name, { 'content-type': 'text/plain', origin: WEB }));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects JSON from a foreign Origin with 403', async () => {
    const res = await handler(post(name, { 'content-type': 'application/json', origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects JSON with no Origin with 403', async () => {
    const res = await handler(post(name, { 'content-type': 'application/json' }));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('lets a same-origin JSON post through to the API', async () => {
    const res = await handler(post(name, { 'content-type': 'application/json', origin: WEB }));
    expect(res.status).toBe(name === 'password-request' ? 202 : 200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
