import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

// `POST /v1/auth/signup` is rate-limited (10/minute) per `req.ip`. This file
// signs up more than 10 users across its test cases, all from vitest's
// single in-process app instance, which would otherwise share one bucket and
// spuriously 429 later tests. Give each signup a distinct simulated remote
// address so they land in separate buckets — this is a test-harness-only
// concern; the production rate limit itself is untouched.
let nextIp = 1;
async function user(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    remoteAddress: `10.0.0.${nextIp++}`,
    payload: { email, password: 'correct horse battery', name: email },
  });
  return { token: res.json().accessToken as string, id: res.json().user.id as string };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe('orgs', () => {
  it('creates an org and makes the creator OWNER', async () => {
    const u = await user('o@x.io');
    const res = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme Inc' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Acme Inc', slug: 'acme-inc', role: 'OWNER' });
    const list = await app.inject({ method: 'GET', url: '/v1/orgs', headers: as(u.token) });
    expect(list.json()).toHaveLength(1);
  });

  it('suffixes a colliding slug', async () => {
    const u = await user('o@x.io');
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme' } });
    const res = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toMatch(/^acme-[a-z0-9]{4}$/);
  });

  it('404s an org the caller is not a member of — never 403', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: as(b.token) });
    expect(res.statusCode).toBe(404);
  });

  it('403s a member below the required role', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'VIEWER' } });
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: as(b.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/members`, headers: as(b.token) })).statusCode).toBe(403);
  });

  it('OWNER can change roles but cannot demote the last OWNER', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const mb = await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'MEMBER' } });
    const ma = await app.prisma.membership.findFirstOrThrow({ where: { userId: a.id, orgId: org.id } });

    expect((await app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${mb.id}`, headers: as(a.token), payload: { role: 'ADMIN' } })).statusCode).toBe(200);
    const self = await app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${ma.id}`, headers: as(a.token), payload: { role: 'ADMIN' } });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ error: 'organization must keep at least one owner' });
  });

  it('OWNER can remove a member but not the last OWNER', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const mb = await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'MEMBER' } });
    const ma = await app.prisma.membership.findFirstOrThrow({ where: { userId: a.id, orgId: org.id } });
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/members/${mb.id}`, headers: as(a.token) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/members/${ma.id}`, headers: as(a.token) })).statusCode).toBe(409);
  });

  it('ADMIN cannot change roles', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'ADMIN' } });
    const ma = await app.prisma.membership.findFirstOrThrow({ where: { userId: a.id, orgId: org.id } });
    expect((await app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${ma.id}`, headers: as(b.token), payload: { role: 'VIEWER' } })).statusCode).toBe(403);
  });

  it('a membership id from ANOTHER org cannot be modified through this org', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const orgA = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const orgB = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(b.token), payload: { name: 'B' } })).json();
    const mb = await app.prisma.membership.findFirstOrThrow({ where: { userId: b.id, orgId: orgB.id } });
    const res = await app.inject({ method: 'PATCH', url: `/v1/orgs/${orgA.id}/members/${mb.id}`, headers: as(a.token), payload: { role: 'VIEWER' } });
    expect(res.statusCode).toBe(404);
    expect((await app.prisma.membership.findUniqueOrThrow({ where: { id: mb.id } })).role).toBe('OWNER');
  });
});
