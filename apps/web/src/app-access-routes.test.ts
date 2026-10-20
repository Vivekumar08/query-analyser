import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { DELETE as deleteApp } from '@/app/api/apps/[id]/route';
import { GET as listAccess } from '@/app/api/apps/[id]/access/route';
import { DELETE as revokeAccess } from '@/app/api/apps/[id]/access/[userId]/route';

const ORIGIN = 'https://app.test';
const appCtx = (id = 'app1') => ({ params: Promise.resolve({ id }) });
const userCtx = (userId = 'u1', id = 'app1') => ({ params: Promise.resolve({ id, userId }) });
const req = (method: string, origin = ORIGIN) => new Request(`${ORIGIN}/api/x`, {
  method,
  headers: { 'content-type': 'application/json', origin, host: 'app.test' },
});
const upstream = (status: number, error = 'x', limit?: string) =>
  vi.mocked(authedFetch).mockResolvedValue({ ok: false, status, error, ...(limit ? { limit } : {}) });
const call = (n = 0) => vi.mocked(authedFetch).mock.calls[n]!;

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ accessToken: 'tok', user: {} } as never);
  vi.mocked(authedFetch).mockReset();
});

describe('app access and app delete routes', () => {
  it('every new route 403s cross-site and 401s without a session, with no-store', async () => {
    const evil = 'https://evil.test';
    for (const res of [
      await deleteApp(req('DELETE', evil), appCtx()),
      await revokeAccess(req('DELETE', evil), userCtx()),
    ]) {
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    vi.mocked(getSession).mockResolvedValue(null as never);
    for (const res of [
      await deleteApp(req('DELETE'), appCtx()),
      await listAccess(req('GET'), appCtx()),
      await revokeAccess(req('DELETE'), userCtx()),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('rejects unsafe id and userId segments with 400', async () => {
    for (const bad of ['.', '..', 'a/b', 'a%2Fb', 'a.b', '']) {
      for (const res of [
        await deleteApp(req('DELETE'), appCtx(bad)),
        await listAccess(req('GET'), appCtx(bad)),
        await revokeAccess(req('DELETE'), userCtx('u1', bad)),
        await revokeAccess(req('DELETE'), userCtx(bad)),
      ]) {
        expect(res.status).toBe(400);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('DELETE app → 204, clears qa_last_app', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: undefined });
    const res = await deleteApp(req('DELETE'), appCtx());
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(call()[0]).toBe('/v1/apps/app1');
    expect(call()[1]).toBe('tok');
    expect(call()[2]!.method).toBe('DELETE');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^qa_last_app=;/);
    expect(cookie).toContain('Path=/dashboard');
    expect(cookie).toContain('Max-Age=0');
  });

  it('DELETE app failures map to fixed copy', async () => {
    upstream(403, 'insufficient role');
    let res = await deleteApp(req('DELETE'), appCtx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only workspace admins can delete apps.' });
    upstream(404, 'Not Found');
    res = await deleteApp(req('DELETE'), appCtx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'That app no longer exists.' });
    expect(res.headers.get('set-cookie')).toBeNull();
    upstream(429);
    res = await deleteApp(req('DELETE'), appCtx());
    expect(res.status).toBe(429);
    upstream(500, 'stack trace detail');
    res = await deleteApp(req('DELETE'), appCtx());
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await res.json())).not.toContain('detail');
  });

  it('GET access passes only allowlisted fields', async () => {
    vi.mocked(authedFetch).mockResolvedValue({
      ok: true,
      data: {
        people: [
          { userId: 'u0', name: 'Olive', email: 'o@b.co', role: 'OWNER', allApps: true, passwordHash: 'h' },
          { userId: 'u1', name: null, email: 'm@b.co', role: 'MEMBER', allApps: false, passwordHash: 'h' },
        ],
        invites: [{ id: 'i1', email: 'n@b.co', role: 'MEMBER', expiresAt: 'e', tokenHash: 't' }],
        seats: { used: 1, max: 1, extra: 1 },
        secret: 's',
      },
    });
    const res = await listAccess(req('GET'), appCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(call()[0]).toBe('/v1/apps/app1/access');
    expect(call()[1]).toBe('tok');
    expect(await res.json()).toEqual({
      people: [
        { userId: 'u0', name: 'Olive', email: 'o@b.co', role: 'OWNER', allApps: true },
        { userId: 'u1', name: null, email: 'm@b.co', role: 'MEMBER', allApps: false },
      ],
      invites: [{ id: 'i1', email: 'n@b.co', role: 'MEMBER', expiresAt: 'e' }],
      seats: { used: 1, max: 1 },
    });
  });

  it('GET access failures map to fixed copy', async () => {
    upstream(403, 'insufficient role');
    let res = await listAccess(req('GET'), appCtx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only workspace admins can see who has access.' });
    upstream(404, 'Not Found');
    res = await listAccess(req('GET'), appCtx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'That app no longer exists.' });
  });

  it('DELETE access → /v1/apps/app1/access/u1; 404 → its copy', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: undefined });
    let res = await revokeAccess(req('DELETE'), userCtx('u1'));
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(call()[0]).toBe('/v1/apps/app1/access/u1');
    expect(call()[2]!.method).toBe('DELETE');
    upstream(404, 'Not Found');
    res = await revokeAccess(req('DELETE'), userCtx('u1'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'That person no longer has access to this app.' });
    upstream(403, 'insufficient role');
    res = await revokeAccess(req('DELETE'), userCtx('u1'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only workspace admins can remove access.' });
  });

  it('a plan-limit 403 on any of them maps to its copy', async () => {
    upstream(403, 'plan-limit', 'seats');
    for (const res of [
      await deleteApp(req('DELETE'), appCtx()),
      await listAccess(req('GET'), appCtx()),
      await revokeAccess(req('DELETE'), userCtx()),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'During the beta, you can invite one teammate. More seats with paid plans.', limit: 'seats' });
    }
  });
});
