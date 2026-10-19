import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { PATCH as patchMe } from '@/app/api/me/route';
import { POST as changePassword } from '@/app/api/me/password/route';
import { DELETE as leave } from '@/app/api/orgs/[org]/membership/route';

const ORIGIN = 'https://app.test';
const orgCtx = (org = 'org1') => ({ params: Promise.resolve({ org }) });
const req = (method: string, body?: unknown, origin = ORIGIN, extra: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/x`, {
    method,
    headers: { 'content-type': 'application/json', origin, host: 'app.test', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const upstream = (status: number, error = 'x') =>
  vi.mocked(authedFetch).mockResolvedValue({ ok: false, status, error } as never);
const call = (n = 0) => vi.mocked(authedFetch).mock.calls[n]!;

const PW = { currentPassword: 'old-password-1', newPassword: 'new-password-12' };

let originalFetch: typeof globalThis.fetch;
let fetchStub: ReturnType<typeof vi.fn>;
const stubFetch = (impl: () => Promise<Response>) => {
  fetchStub = vi.fn(impl);
  globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;
};
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  process.env.WEB_ORIGIN = ORIGIN;
  originalFetch = globalThis.fetch;
  stubFetch(async () => { throw new Error('fetch not stubbed for this test'); });
  vi.mocked(getSession).mockResolvedValue({ accessToken: 'tok', user: {} } as never);
  vi.mocked(authedFetch).mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('cross-site, session and params', () => {
  it('every route 403s a cross-site request with no-store, upstream untouched', async () => {
    const evil = 'https://evil.test';
    const responses = [
      await patchMe(req('PATCH', { name: 'Ada' }, evil)),
      await changePassword(req('POST', PW, evil)),
      await leave(req('DELETE', undefined, evil), orgCtx()),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(authedFetch).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('every route 401s without a session', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    const responses = [
      await patchMe(req('PATCH', { name: 'Ada' })),
      await changePassword(req('POST', PW)),
      await leave(req('DELETE'), orgCtx()),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(authedFetch).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('membership rejects unsafe org segments with 400', async () => {
    for (const bad of ['.', '..', 'a/b', 'a.b', '']) {
      const res = await leave(req('DELETE'), orgCtx(bad));
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(authedFetch).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/me', () => {
  it('forwards only a trimmed name', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { id: 'u1', email: 'a@b.co', name: 'Ada' } } as never);
    const res = await patchMe(req('PATCH', { name: ' Ada ', email: 'x@y.z', isPlatformAdmin: true }));
    expect(call()).toEqual(['/v1/me', 'tok', { method: 'PATCH', body: '{"name":"Ada"}' }]);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ name: 'Ada' });
  });

  it('400s a blank, over-long or non-string name without calling upstream', async () => {
    for (const name of ['  ', 'x'.repeat(101), 5, undefined]) {
      const res = await patchMe(req('PATCH', { name }));
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'Enter a name between 1 and 100 characters.' });
    }
    const malformed = await patchMe(new Request(`${ORIGIN}/api/x`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'app.test' }, body: '{',
    }));
    expect(malformed.status).toBe(400);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 characters after trimming', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { name: 'x'.repeat(100) } } as never);
    const res = await patchMe(req('PATCH', { name: ` ${'x'.repeat(100)} ` }));
    expect(res.status).toBe(200);
  });

  it('maps upstream failures to fixed copy, never echoing upstream text', async () => {
    const cases: Array<[number, number, string]> = [
      [400, 400, 'Enter a name between 1 and 100 characters.'],
      [401, 401, 'unauthorized'],
      [403, 403, "You don't have permission to do that."],
      [429, 429, 'Too many attempts — wait a minute and try again.'],
      [500, 502, 'Something went wrong. Please try again.'],
    ];
    for (const [up, status, error] of cases) {
      upstream(up, 'secret upstream text');
      const res = await patchMe(req('PATCH', { name: 'Ada' }));
      expect(res.status).toBe(status);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error });
    }
  });
});

describe('POST /api/me/password', () => {
  it('forwards only the two fields, with the bearer token and the browser IP, and sets both session cookies (Review Focus)', async () => {
    stubFetch(async () => jsonResponse(
      200,
      { accessToken: 'new-tok', user: { id: 'u1', email: 'a@b.co', name: 'Ada', isPlatformAdmin: false } },
      { 'set-cookie': 'qa_refresh=r2; Path=/v1/auth; HttpOnly; SameSite=Lax' },
    ));
    const res = await changePassword(req('POST', { ...PW, email: 'x@y.z', userId: 'other' }, ORIGIN, {
      'x-forwarded-for': '203.0.113.9',
    }));

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/me/password');
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');
    expect(JSON.parse(init.body as string)).toEqual(PW);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-qa-client-ip')).toBe('203.0.113.9');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('qa_session='))!;
    expect(session).toMatch(/^qa_session=new-tok;/);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Path=\//);
    const refresh = cookies.find((c) => c.startsWith('qa_refresh='))!;
    expect(refresh).toContain('qa_refresh=r2');
    expect(refresh).toContain('Path=/api/auth');
    expect(refresh).not.toContain('/v1/auth');
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain('new-tok');
  });

  it('maps 403 wrong-password to its copy and sets no cookies', async () => {
    stubFetch(async () => jsonResponse(403, { error: 'wrong-password' }));
    const res = await changePassword(req('POST', PW));
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Your current password is incorrect.' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('maps 409 password-changed to sign-in-again copy, no cookies', async () => {
    stubFetch(async () => jsonResponse(409, { error: 'password-changed' }));
    const res = await changePassword(req('POST', PW));
    expect(res.status).toBe(409);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Your password was just changed elsewhere. Sign in again.' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('maps upstream 400 and 401 to fixed copy', async () => {
    stubFetch(async () => jsonResponse(400, { error: 'new password must differ from the current one' }));
    let res = await changePassword(req('POST', PW));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Choose a new password of 12–200 characters that differs from your current one.',
    });
    stubFetch(async () => jsonResponse(401, { error: 'unauthorized' }));
    res = await changePassword(req('POST', PW));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('400s a new password under 12 or over 200 chars without calling upstream', async () => {
    const bodies: unknown[] = [
      { currentPassword: 'old-password-1', newPassword: 'x'.repeat(11) },
      { currentPassword: 'old-password-1', newPassword: 'x'.repeat(201) },
      { currentPassword: '', newPassword: 'new-password-12' },
      { currentPassword: 'x'.repeat(201), newPassword: 'new-password-12' },
      { currentPassword: 5, newPassword: 'new-password-12' },
      { currentPassword: 'old-password-1', newPassword: null },
      {},
    ];
    for (const body of bodies) {
      const res = await changePassword(req('POST', body));
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        error: 'Choose a new password of 12–200 characters that differs from your current one.',
      });
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('maps an upstream 429 and a network failure', async () => {
    stubFetch(async () => jsonResponse(429, { error: 'Rate limit exceeded, retry in 1 minute' }));
    let res = await changePassword(req('POST', PW));
    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Too many attempts — wait a minute and try again.' });

    stubFetch(async () => { throw new TypeError('fetch failed'); });
    res = await changePassword(req('POST', PW));
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Something went wrong. Please try again.' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('502s a 2xx without an access token and sets no cookies', async () => {
    stubFetch(async () => jsonResponse(200, { user: {} }, { 'set-cookie': 'qa_refresh=r2; Path=/v1/auth' }));
    const res = await changePassword(req('POST', PW));
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe('DELETE /api/orgs/[org]/membership', () => {
  it('204 clears the last-app cookie', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: undefined } as never);
    const res = await leave(req('DELETE'), orgCtx('org1'));
    expect(call()[0]).toBe('/v1/orgs/org1/membership');
    expect(call()[1]).toBe('tok');
    expect(call()[2]).toEqual({ method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const c = res.headers.getSetCookie().find((x) => x.startsWith('qa_last_app='))!;
    expect(c).toMatch(/^qa_last_app=;/);
    expect(c).toMatch(/Path=\/dashboard/);
    expect(c).toMatch(/Max-Age=0/);
  });

  it('409 → the only-owner copy, cookie untouched', async () => {
    upstream(409, 'organization must keep at least one owner');
    const res = await leave(req('DELETE'), orgCtx());
    expect(res.status).toBe(409);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: "You're the only owner. Make someone else an owner first." });
    expect(res.headers.getSetCookie().some((x) => x.startsWith('qa_last_app='))).toBe(false);
  });

  it('404 → no-longer-a-member copy', async () => {
    upstream(404, 'Not Found');
    const res = await leave(req('DELETE'), orgCtx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "You're no longer a member of this organisation." });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('maps 401, 403, 429 and others to fixed copy', async () => {
    const cases: Array<[number, number, string]> = [
      [401, 401, 'unauthorized'],
      [403, 403, "You don't have permission to do that."],
      [429, 429, 'Too many attempts — wait a minute and try again.'],
      [500, 502, 'Something went wrong. Please try again.'],
    ];
    for (const [up, status, error] of cases) {
      upstream(up, 'secret upstream text');
      const res = await leave(req('DELETE'), orgCtx());
      expect(res.status).toBe(status);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });
});
