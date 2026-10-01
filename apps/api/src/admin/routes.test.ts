import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function user(email: string, platformAdmin = false) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: 'correct horse battery', name: email } });
  if (platformAdmin) await app.prisma.user.update({ where: { email }, data: { isPlatformAdmin: true } });
  return { id: s.json().user.id as string, h: { authorization: `Bearer ${s.json().accessToken}` } };
}

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

describe('admin', () => {
  it.each([
    { method: 'GET', url: '/v1/admin/orgs' },
    { method: 'GET', url: `/v1/admin/orgs/${MISSING_ID}` },
    { method: 'POST', url: `/v1/admin/orgs/${MISSING_ID}/suspend` },
    { method: 'POST', url: `/v1/admin/orgs/${MISSING_ID}/unsuspend` },
    { method: 'GET', url: '/v1/admin/health' },
  ] as const)('404s a non-admin and 401s anonymous on $method $url', async ({ method, url }) => {
    const u = await user('u@x.io');
    const nonAdmin = await app.inject({ method, url, headers: u.h });
    expect(nonAdmin.statusCode).toBe(404);
    expect(nonAdmin.json()).toEqual({ error: 'Not Found' });

    const anon = await app.inject({ method, url });
    expect(anon.statusCode).toBe(401);
  });

  it('lists orgs with counts for a platform admin', async () => {
    const u = await user('u@x.io');
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: u.h, payload: { name: 'Cust' } });
    const admin = await user('root@x.io', true);
    const res = await app.inject({ method: 'GET', url: '/v1/admin/orgs', headers: admin.h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ name: 'Cust', appCount: 0, memberCount: 1, suspendedAt: null })]);
  });

  it('suspends and unsuspends an org, and suspension blocks the org members', async () => {
    const u = await user('u@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: u.h, payload: { name: 'Cust' } })).json();
    const admin = await user('root@x.io', true);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/orgs/${org.id}/suspend`, headers: admin.h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: u.h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/orgs/${org.id}/unsuspend`, headers: admin.h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: u.h })).statusCode).toBe(200);
  });

  it('404s suspend/unsuspend for an unknown org id', async () => {
    const admin = await user('root@x.io', true);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/orgs/${MISSING_ID}/suspend`, headers: admin.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/orgs/${MISSING_ID}/unsuspend`, headers: admin.h })).statusCode).toBe(404);
  });

  it('returns org detail with apps and signature counts, and 404s an unknown id', async () => {
    const u = await user('u@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: u.h, payload: { name: 'Cust' } })).json();
    await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/apps`, headers: u.h, payload: { name: 'web', env: 'prod' } });
    const admin = await user('root@x.io', true);

    const res = await app.inject({ method: 'GET', url: `/v1/admin/orgs/${org.id}`, headers: admin.h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({
      id: org.id,
      name: 'Cust',
      suspendedAt: null,
      apps: [expect.objectContaining({ name: 'web', env: 'prod', signatureCount: 0 })],
    }));

    const missing = await app.inject({ method: 'GET', url: `/v1/admin/orgs/${MISSING_ID}`, headers: admin.h });
    expect(missing.statusCode).toBe(404);
  });

  it('reports ingest counters', async () => {
    const admin = await user('root@x.io', true);
    await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: 'Bearer nope' }, payload: {} });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/health', headers: admin.h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ batches: expect.any(Number), rejected401: expect.any(Number), since: expect.any(String) });
    expect(res.json().rejected401).toBeGreaterThanOrEqual(1);
  });

  it('counts a plugin-level rate-limit 429 in rejected429, not just the signature-quota 429', async () => {
    // A dedicated low-limit instance, same technique as
    // ingest/routes.test.ts's rate-limit suite: a fresh unknown
    // Authorization header on every request still shares one bucket because
    // the limiter keys on req.ip, so the 4th request in a row 429s before
    // ever reaching the ingest handler's own quota check.
    const limited = await buildApp({ logger: false, rateLimitMax: 3 });
    try {
      const signup = await limited.inject({
        method: 'POST', url: '/v1/auth/signup',
        payload: { email: 'root2@x.io', password: 'correct horse battery', name: 'root2@x.io' },
      });
      await limited.prisma.user.update({ where: { email: 'root2@x.io' }, data: { isPlatformAdmin: true } });
      const h = { authorization: `Bearer ${signup.json().accessToken}` };

      for (let i = 0; i < 4; i++) {
        // eslint-disable-next-line no-await-in-loop
        await limited.inject({
          method: 'POST', url: '/v1/ingest',
          headers: { authorization: `Bearer qa_live_${i.toString().padStart(32, '0')}` },
          payload: {},
        });
      }

      const res = await limited.inject({ method: 'GET', url: '/v1/admin/health', headers: h });
      expect(res.statusCode).toBe(200);
      expect(res.json().rejected429).toBeGreaterThanOrEqual(1);
    } finally {
      await limited.close();
    }
  });
});
