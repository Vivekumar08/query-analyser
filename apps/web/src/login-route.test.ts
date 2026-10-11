import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '../app/api/auth/login/route.js';

const ORIGIN = 'https://api.example.com';
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  process.env.API_ORIGIN = ORIGIN;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('POST /api/auth/login', () => {
  it('forwards the re-scoped refresh cookie alongside its own session cookie', async () => {
    // Proves the route handler itself calls forwardRefreshCookie — the
    // helper's own unit tests only pin the helper, not its use here. Without
    // this call every session would die silently 15 minutes after login.
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

    const req = new Request('https://web.example.com/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@b.com', password: 'secret' }),
    });
    const res = await POST(req);
    const all = res.headers.getSetCookie();

    expect(all.some((c) => c.startsWith('qa_session='))).toBe(true);
    const refreshCookie = all.find((c) => c.startsWith('qa_refresh='));
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain('Path=/api/auth');
  });
});
