import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { PATCH } from '@/app/api/apps/[id]/advice/[adviceId]/route';

const ORIGIN = 'https://app.test';
const ctx = { params: Promise.resolve({ id: 'a1', adviceId: 'ad1' }) };
const req = (body: unknown, origin = ORIGIN) => new Request(`${ORIGIN}/api/apps/a1/advice/ad1`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', origin, host: 'app.test' }, body: JSON.stringify(body),
});

beforeEach(() => {
  process.env.WEB_ORIGIN = ORIGIN;
  vi.mocked(getSession).mockResolvedValue({ accessToken: 'tok', user: {} } as never);
  vi.mocked(authedFetch).mockReset();
});

describe('PATCH advice', () => {
  it('cross-site → 403, API untouched', async () => {
    expect((await PATCH(req({ status: 'APPLIED' }, 'https://evil.test'), ctx)).status).toBe(403);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('no session → 401, API untouched', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    expect((await PATCH(req({ status: 'APPLIED' }), ctx)).status).toBe(401);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('rejects anything but APPLIED/DISMISSED (there is no way back to OPEN)', async () => {
    expect((await PATCH(req({ status: 'OPEN' }), ctx)).status).toBe(400);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('forwards with the token server-side', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { status: 'APPLIED' } });
    const res = await PATCH(req({ status: 'APPLIED' }), ctx);
    expect(res.status).toBe(200);
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a1/advice/ad1');
    expect(vi.mocked(authedFetch).mock.calls[0]![1]).toBe('tok');
  });
  it('upstream 403 maps to a safe message', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 403, error: 'role VIEWER' });
    const res = await PATCH(req({ status: 'DISMISSED' }), ctx);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('VIEWER');
  });
  it('upstream 404 → 404 and 5xx → 502', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 404, error: 'x' });
    expect((await PATCH(req({ status: 'APPLIED' }), ctx)).status).toBe(404);
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 503, error: 'x' });
    expect((await PATCH(req({ status: 'APPLIED' }), ctx)).status).toBe(502);
  });
  it('upstream 401 → 401 (so the client can refresh the session)', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 401, error: 'expired' });
    expect((await PATCH(req({ status: 'APPLIED' }), ctx)).status).toBe(401);
  });
  it('upstream 400 → 400 with an advice-specific message, not the name message', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 400, error: 'bad' });
    const res = await PATCH(req({ status: 'APPLIED' }), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This suggestion can't be updated." });
  });
});
