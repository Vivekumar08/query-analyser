import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { DELETE, GET, PUT } from '@/app/api/apps/[id]/sample-key/route';

const ORIGIN = 'https://app.test';
const ctx = { params: Promise.resolve({ id: 'a1' }) };
const URL_ = `${ORIGIN}/api/apps/a1/sample-key`;
const wrapped = { v: 1, salt: 'c2FsdA==', iv: 'aXY=', iterations: 600000, ciphertext: 'Y3Q=' };
const body = { publicKey: 'UEs=', wrapped };
const put = (b: unknown, origin = ORIGIN) => new Request(URL_, {
  method: 'PUT', headers: { 'content-type': 'application/json', origin, host: 'app.test' }, body: JSON.stringify(b),
});
const del = (origin = ORIGIN) => new Request(URL_, {
  method: 'DELETE', headers: { 'content-type': 'application/json', origin, host: 'app.test' },
});

beforeEach(() => {
  process.env.WEB_ORIGIN = ORIGIN;
  vi.mocked(getSession).mockResolvedValue({ accessToken: 'tok', user: {} } as never);
  vi.mocked(authedFetch).mockReset();
});

describe('GET sample-key', () => {
  it('passes the status through with no-store (a VIEWER may read it)', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { enabled: true, publicKey: 'UEs=', wrapped } });
    const res = await GET(new Request(URL_), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ enabled: true, publicKey: 'UEs=', wrapped });
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a1/sample-key');
    expect(vi.mocked(authedFetch).mock.calls[0]![1]).toBe('tok');
  });
  it('no session → 401, API untouched', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    expect((await GET(new Request(URL_), ctx)).status).toBe(401);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('upstream 404 → 404 and 5xx → 502', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 404, error: 'x' });
    expect((await GET(new Request(URL_), ctx)).status).toBe(404);
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 500, error: 'x' });
    expect((await GET(new Request(URL_), ctx)).status).toBe(502);
  });
});

describe('PUT sample-key', () => {
  it('cross-site → 403, API untouched', async () => {
    expect((await PUT(put(body, 'https://evil.test'), ctx)).status).toBe(403);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('no session → 401, API untouched', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    expect((await PUT(put(body), ctx)).status).toBe(401);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('forwards only {publicKey, wrapped} — a stray passphrase or private key is dropped', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { enabled: true, publicKey: 'UEs=' } });
    const res = await PUT(put({ ...body, passphrase: 'hunter2 hunter2', privateKey: 'secret', wrapped: { ...wrapped, passphrase: 'x' } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ enabled: true, publicKey: 'UEs=' });
    const [path, token, init] = vi.mocked(authedFetch).mock.calls[0]!;
    expect(path).toBe('/v1/apps/a1/sample-key');
    expect(token).toBe('tok');
    expect(init!.method).toBe('PUT');
    const sent = JSON.parse(init!.body as string);
    expect(sent).toEqual(body);
    expect(Object.keys(sent).sort()).toEqual(['publicKey', 'wrapped']);
    expect(init!.body).not.toMatch(/passphrase|privateKey|hunter2|secret/);
  });
  it('a malformed body → 400, API untouched', async () => {
    expect((await PUT(put({ publicKey: 'UEs=' }), ctx)).status).toBe(400);
    expect((await PUT(put({ publicKey: 1, wrapped }), ctx)).status).toBe(400);
    expect((await PUT(put({ publicKey: 'UEs=', wrapped: { ...wrapped, iterations: '600000' } }), ctx)).status).toBe(400);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('upstream 403 → "Only workspace admins can change this."', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 403, error: 'insufficient role' });
    const res = await PUT(put(body), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only workspace admins can change this.' });
  });
  it('upstream 400 → 400 with a safe message; 401 stays 401; 5xx → 502', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 400, error: 'invalid-public-key detail' });
    const bad = await PUT(put(body), ctx);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).not.toContain('detail');
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 401, error: 'expired' });
    expect((await PUT(put(body), ctx)).status).toBe(401);
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 503, error: 'x' });
    expect((await PUT(put(body), ctx)).status).toBe(502);
  });
});

describe('DELETE sample-key', () => {
  it('cross-site → 403, API untouched', async () => {
    expect((await DELETE(del('https://evil.test'), ctx)).status).toBe(403);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('forwards and returns 204 with no-store', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: undefined });
    const res = await DELETE(del(), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a1/sample-key');
    expect(vi.mocked(authedFetch).mock.calls[0]![2]!.method).toBe('DELETE');
  });
  it('upstream 403 → "Only workspace admins can change this."', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 403, error: 'insufficient role' });
    const res = await DELETE(del(), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only workspace admins can change this.' });
  });
});
