import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function user(email: string) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: 'correct horse battery', name: email } });
  return { id: s.json().user.id as string, h: { authorization: `Bearer ${s.json().accessToken}` } };
}

describe('invites', () => {
  it('ADMIN+ creates an invite; the invitee accepts and becomes a member', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const inv = await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } });
    expect(inv.statusCode).toBe(201);
    const { token } = inv.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const list = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/invites`, headers: o.h });
    expect(JSON.stringify(list.json())).not.toContain(token);

    const n = await user('n@x.io');
    const acc = await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toEqual({ orgId: org.id, role: 'MEMBER' });
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);

    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(410);
  });

  it('403s acceptance by a user with a different email', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    const other = await user('other@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: other.h })).statusCode).toBe(403);
  });

  it('410s an expired invite', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token, id } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    await app.prisma.invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const n = await user('n@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(410);
  });

  it('ADMIN cannot invite an OWNER; OWNER can', async () => {
    const o = await user('o@x.io'); const a = await user('a@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    await app.prisma.membership.create({ data: { userId: a.id, orgId: org.id, role: 'ADMIN' } });
    expect((await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: a.h, payload: { email: 'n@x.io', role: 'OWNER' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'OWNER' } })).statusCode).toBe(201);
  });

  it('404s an unknown token and 409s an existing member', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${'x'.repeat(43)}/accept`, headers: o.h })).statusCode).toBe(404);
    const { token } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'o@x.io', role: 'MEMBER' } })).json();
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: o.h })).statusCode).toBe(409);
  });
});
