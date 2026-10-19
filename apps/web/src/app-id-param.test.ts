import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { POST as createKey } from '@/app/api/apps/[id]/keys/route';
import { GET as status } from '@/app/api/apps/[id]/status/route';
import { PATCH as patchAdvice } from '@/app/api/apps/[id]/advice/[adviceId]/route';
import { DELETE as delSampleKey, GET as getSampleKey, PUT as putSampleKey } from '@/app/api/apps/[id]/sample-key/route';

/*
 * Every app/api/apps/[id]/** route refuses a path param that isn't a plain
 * id segment (isSafeSegment) with a 400, before any upstream URL is built:
 * `..` and `.` collapse the upstream path even after encodeURIComponent.
 */

const ORIGIN = 'https://app.test';
const req = (method: string, body?: unknown) => new Request(`${ORIGIN}/api/apps/x`, {
  method,
  headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'app.test' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const wrapped = { v: 1, salt: 'c2FsdA==', iv: 'aXY=', iterations: 600000, ciphertext: 'Y3Q=' };

beforeEach(() => {
  process.env.WEB_ORIGIN = ORIGIN;
  vi.mocked(getSession).mockResolvedValue({ accessToken: 'tok', user: {} } as never);
  vi.mocked(authedFetch).mockReset();
  vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { ingest: { lastSeenAt: null } } } as never);
});

const routes: [string, (id: string) => Promise<Response>][] = [
  ['POST keys', (id) => createKey(req('POST', {}), { params: Promise.resolve({ id }) })],
  ['GET status', (id) => status(req('GET'), { params: Promise.resolve({ id }) })],
  ['PATCH advice (app id)', (id) => patchAdvice(req('PATCH', { status: 'APPLIED' }), { params: Promise.resolve({ id, adviceId: 'ad1' }) })],
  ['PATCH advice (advice id)', (id) => patchAdvice(req('PATCH', { status: 'APPLIED' }), { params: Promise.resolve({ id: 'a1', adviceId: id }) })],
  ['GET sample-key', (id) => getSampleKey(req('GET'), { params: Promise.resolve({ id }) })],
  ['PUT sample-key', (id) => putSampleKey(req('PUT', { publicKey: 'UEs=', wrapped }), { params: Promise.resolve({ id }) })],
  ['DELETE sample-key', (id) => delSampleKey(req('DELETE'), { params: Promise.resolve({ id }) })],
];

describe('app/api/apps/[id]/** path params', () => {
  describe.each(routes)('%s', (_name, call) => {
    it.each(['..', '.', 'a/b', ''])('refuses %j with 400, API untouched', async (id) => {
      const res = await call(id);
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(authedFetch).not.toHaveBeenCalled();
    });

    it('still forwards a plain id', async () => {
      const res = await call('a1');
      expect(res.status).toBeLessThan(400);
      expect(authedFetch).toHaveBeenCalledTimes(1);
    });
  });
});
