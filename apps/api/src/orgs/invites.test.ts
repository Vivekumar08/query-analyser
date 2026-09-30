import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Writable } from 'node:stream';
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

  // Regression test for the single-use race: the brief's original sample
  // implementation reads `acceptedAt`, then later writes a membership row
  // and marks the invite accepted, as two logically separate steps. Fired
  // concurrently, two accepts of the *same* token can both pass that read
  // before either write lands, so both would succeed and create two
  // memberships. The fix claims the invite atomically (`updateMany` guarded
  // by `acceptedAt: null` in its own `where`), so exactly one of two
  // concurrent accepts must win.
  it('accepts exactly once under two concurrent accepts of the same token', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    const n = await user('n@x.io');

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h }),
      app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 410]);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);
  });

  // Covers the P2002 fallback at the bottom of the accept route's catch
  // block: the pre-transaction `already` check only guards against the
  // *same* invite being accepted twice by the same user for the same org —
  // it doesn't stop two different, still-valid invites into the *same* org
  // for the same user racing each other's membership-create. Fire both
  // concurrently and require that exactly one becomes a member (either via
  // the pre-check 409 or the P2002-mapped 409), never two memberships.
  it('409s one of two concurrent accepts of different invites into the same org for the same user', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token: t1 } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    const { token: t2 } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'VIEWER' } })).json();
    const n = await user('n@x.io');

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/invites/${t1}/accept`, headers: n.h }),
      app.inject({ method: 'POST', url: `/v1/invites/${t2}/accept`, headers: n.h }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);
  });

  it('403s acceptance for a suspended org', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    await app.prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });
    const n = await user('n@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(403);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(0);
  });

  it('403s issuing an invite for a suspended org', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    await app.prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });
    expect((await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).statusCode).toBe(403);
  });
});

describe('invite token log redaction', () => {
  it('never writes the accept token into the request log, even for a failed attempt', async () => {
    const lines: string[] = [];
    const capture = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logApp = await buildApp({ logStream: capture });
    await logApp.ready();

    const token = 'A'.repeat(43);
    // Deliberately unauthenticated: the request log line is written before
    // any preHandler runs, so even a request that never reaches the route
    // handler (401 here) must not have the token appear in the log.
    const res = await logApp.inject({ method: 'POST', url: `/v1/invites/${token}/accept` });
    expect(res.statusCode).toBe(401);

    await logApp.close();

    const combined = lines.join('\n');
    expect(combined).not.toContain(token);
    expect(combined).toContain('/v1/invites/[redacted]/accept');
  });
});
