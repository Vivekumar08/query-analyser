import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCredentialsAuth } from './credentials-auth.js';
import { POST as loginPost } from '../app/api/auth/login/route.js';
import { POST as signupPost } from '../app/api/auth/signup/route.js';

const ORIGIN = 'https://api.example.com';
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  process.env.API_ORIGIN = ORIGIN;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const stubUpstreamSuccess = () => {
  globalThis.fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify({ accessToken: 'tok123' }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'qa_refresh=refreshtok; Path=/v1/auth; HttpOnly; Secure; SameSite=Lax',
      },
    },
  )) as unknown as typeof globalThis.fetch;
};

describe('handleCredentialsAuth', () => {
  // Shared by login and signup, so a single parametrised suite exercises
  // both — losing the forwarding call for either path would show up here,
  // rather than only for whichever route happened to have its own test.
  it.each(['/v1/auth/login', '/v1/auth/signup'] as const)(
    'forwards the re-scoped refresh cookie alongside its own session cookie (%s)',
    async (upstreamPath) => {
      stubUpstreamSuccess();
      const res = await handleCredentialsAuth(upstreamPath, JSON.stringify({ email: 'a@b.com', password: 'x' }));
      const all = res.headers.getSetCookie();

      expect(all.some((c) => c.startsWith('qa_session='))).toBe(true);
      const refreshCookie = all.find((c) => c.startsWith('qa_refresh='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toContain('Path=/api/auth');
    },
  );

  it('passes a non-2xx upstream status and body through unchanged', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'bad credentials' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

    const res = await handleCredentialsAuth('/v1/auth/login', JSON.stringify({ email: 'a@b.com', password: 'x' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad credentials' });
  });
});

describe('route wiring', () => {
  // Pins that the route files actually call handleCredentialsAuth — a
  // perfectly tested helper that nothing calls is the failure this whole
  // suite exists to catch.
  it('POST /api/auth/login forwards the re-scoped refresh cookie', async () => {
    stubUpstreamSuccess();
    const req = new Request('https://web.example.com/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@b.com', password: 'secret' }),
    });
    const res = await loginPost(req);
    const all = res.headers.getSetCookie();
    expect(all.some((c) => c.startsWith('qa_session='))).toBe(true);
    expect(all.some((c) => c.startsWith('qa_refresh=') && c.includes('Path=/api/auth'))).toBe(true);
  });

  it('POST /api/auth/signup forwards the re-scoped refresh cookie', async () => {
    stubUpstreamSuccess();
    const req = new Request('https://web.example.com/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@b.com', password: 'secret' }),
    });
    const res = await signupPost(req);
    const all = res.headers.getSetCookie();
    expect(all.some((c) => c.startsWith('qa_session='))).toBe(true);
    expect(all.some((c) => c.startsWith('qa_refresh=') && c.includes('Path=/api/auth'))).toBe(true);
  });
});
