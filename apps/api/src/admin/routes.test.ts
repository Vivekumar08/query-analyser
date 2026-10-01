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

describe('admin', () => {
  it('404s non-admins and 401s anonymous', async () => {
    const u = await user('u@x.io');
    expect((await app.inject({ method: 'GET', url: '/v1/admin/orgs', headers: u.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/orgs' })).statusCode).toBe(401);
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

  it('reports ingest counters', async () => {
    const admin = await user('root@x.io', true);
    await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: 'Bearer nope' }, payload: {} });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/health', headers: admin.h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ batches: expect.any(Number), rejected401: expect.any(Number), since: expect.any(String) });
    expect(res.json().rejected401).toBeGreaterThanOrEqual(1);
  });
});
