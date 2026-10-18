// apps/web/src/onboarding-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { POST as createOrg } from '@/app/api/onboarding/org/route';
import { POST as createApp } from '@/app/api/onboarding/app/route';
import { POST as verifyRequest } from '@/app/api/auth/verify-request/route';
import { GET as status } from '@/app/api/apps/[id]/status/route';

const ORIGIN = 'https://app.test';
const session = { accessToken: 'tok', user: { id: 'u', email: 'e', name: 'n', isPlatformAdmin: false, emailVerifiedAt: 'x' } };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'app.test', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.WEB_ORIGIN = ORIGIN;
  vi.mocked(getSession).mockResolvedValue(session as never);
  vi.mocked(authedFetch).mockReset();
});

describe('POST /api/onboarding/org', () => {
  it('rejects a cross-site post before touching the API', async () => {
    const res = await createOrg(post('/api/onboarding/org', { name: 'Acme' }, { origin: 'https://evil.test' }));
    expect(res.status).toBe(403);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('401 without a session', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await createOrg(post('/api/onboarding/org', { name: 'Acme' }))).status).toBe(401);
  });
  it('creates the org with the token server-side', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { slug: 'acme', name: 'Acme' } });
    const res = await createOrg(post('/api/onboarding/org', { name: 'Acme' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ slug: 'acme', name: 'Acme' });
    expect(vi.mocked(authedFetch).mock.calls[0]![1]).toBe('tok');
  });
  it('409 maps to message, never the raw body', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 409, error: 'internal detail' });
    const res = await createOrg(post('/api/onboarding/org', { name: 'Acme' }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/taken/);
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });
});

const orgs = [{ id: 'org-id-1', slug: 'acme', name: 'Acme', plan: 'free', createdAt: 'x', role: 'OWNER' }];

describe('POST /api/onboarding/app', () => {
  it('rejects a cross-site post before touching the API', async () => {
    const res = await createApp(post('/api/onboarding/app', { org: 'acme', name: 'svc' }, { origin: 'https://evil.test' }));
    expect(res.status).toBe(403);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('401 without a session', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await createApp(post('/api/onboarding/app', { org: 'acme', name: 'svc' }))).status).toBe(401);
  });
  it('maps the slug to the org id, creates the app with env, then the key, returning the key once', async () => {
    vi.mocked(authedFetch)
      .mockResolvedValueOnce({ ok: true, data: orgs })
      .mockResolvedValueOnce({ ok: true, data: { id: 'a1', name: 'svc' } })
      .mockResolvedValueOnce({ ok: true, data: { id: 'k1', prefix: 'qa_', key: 'qa_secret' } });
    const res = await createApp(post('/api/onboarding/app', { org: 'acme', name: 'svc' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ app: { id: 'a1', name: 'svc' }, key: 'qa_secret' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location')).toBeNull();
    const calls = vi.mocked(authedFetch).mock.calls;
    expect(calls[0]![0]).toBe('/v1/orgs');
    expect(calls[1]![0]).toBe('/v1/orgs/org-id-1/apps');
    expect(JSON.parse(calls[1]![2]!.body as string)).toEqual({ name: 'svc', env: 'production' });
    expect(calls[2]![0]).toBe('/v1/apps/a1/keys');
  });
  it('404 and no app creation when the user is not a member of the slug', async () => {
    vi.mocked(authedFetch).mockResolvedValueOnce({ ok: true, data: orgs });
    const res = await createApp(post('/api/onboarding/app', { org: 'someone-elses', name: 'svc' }));
    expect(res.status).toBe(404);
    expect(authedFetch).toHaveBeenCalledTimes(1);
  });
  it('409 maps to message, never the raw body', async () => {
    vi.mocked(authedFetch)
      .mockResolvedValueOnce({ ok: true, data: orgs })
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'internal detail' });
    const res = await createApp(post('/api/onboarding/app', { org: 'acme', name: 'svc' }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already exists/);
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });
  it('key creation failure still returns the app, with key null', async () => {
    vi.mocked(authedFetch)
      .mockResolvedValueOnce({ ok: true, data: orgs })
      .mockResolvedValueOnce({ ok: true, data: { id: 'a1', name: 'svc' } })
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'x' });
    const res = await createApp(post('/api/onboarding/app', { org: 'acme', name: 'svc' }));
    expect(await res.json()).toEqual({ app: { id: 'a1', name: 'svc' }, key: null });
  });
  it('rejects an invalid body', async () => {
    expect((await createApp(post('/api/onboarding/app', { org: '', name: '' }))).status).toBe(400);
  });
});

describe('POST /api/auth/verify-request', () => {
  it('cross-site is 403 and never calls the API', async () => {
    const res = await verifyRequest(post('/api/auth/verify-request', {}, { origin: 'https://evil.test' }));
    expect(res.status).toBe(403);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('401 without a session', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await verifyRequest(post('/api/auth/verify-request', {}))).status).toBe(401);
  });
  it('202 sent with the bearer token and forwarded client ip, even if upstream fails', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 429, error: 'x' });
    const res = await verifyRequest(post('/api/auth/verify-request', {}, { 'x-forwarded-for': '9.9.9.9' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'sent' });
    const call = vi.mocked(authedFetch).mock.calls[0]!;
    expect(call[0]).toBe('/v1/auth/verify/request');
    expect(call[1]).toBe('tok');
    expect(new Headers(call[2]!.headers).get('x-qa-client-ip')).toBe('9.9.9.9');
  });
});

describe('GET /api/apps/[id]/status', () => {
  it('returns only lastSeenAt, no-store', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { id: 'a1', name: 'svc', ingest: { lastSeenAt: '2026-10-18T00:00:00.000Z', keyCount: 1 } } });
    const res = await status(new Request(`${ORIGIN}/api/apps/a1/status`), { params: Promise.resolve({ id: 'a1' }) });
    expect(await res.json()).toEqual({ lastSeenAt: '2026-10-18T00:00:00.000Z' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('maps upstream 403/404 to 404', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 403, error: 'x' });
    const res = await status(new Request(`${ORIGIN}/api/apps/a1/status`), { params: Promise.resolve({ id: 'a1' }) });
    expect(res.status).toBe(404);
  });
});
