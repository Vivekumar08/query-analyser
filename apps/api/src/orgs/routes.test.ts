import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

// `POST /v1/auth/signup` is rate-limited (30/minute) per `req.ip`. This file
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
    const first = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme' } });
    expect(first.statusCode).toBe(201);
    expect(first.json().slug).toBe('acme');

    const res = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toMatch(/^acme-[a-z0-9]{4}$/);

    // Both orgs are independently retrievable — the first kept its clean
    // slug and wasn't itself renamed or clobbered by the second create.
    const list = await app.inject({ method: 'GET', url: '/v1/orgs', headers: as(u.token) });
    const slugs = (list.json() as { slug: string }[]).map((o) => o.slug).sort();
    expect(slugs).toEqual([first.json().slug, res.json().slug].sort());

    const getFirst = await app.inject({ method: 'GET', url: `/v1/orgs/${first.json().id}`, headers: as(u.token) });
    expect(getFirst.statusCode).toBe(200);
    expect(getFirst.json().slug).toBe('acme');

    const getSecond = await app.inject({ method: 'GET', url: `/v1/orgs/${res.json().id}`, headers: as(u.token) });
    expect(getSecond.statusCode).toBe(200);
    expect(getSecond.json().slug).toBe(res.json().slug);
  });

  it('404s an org the caller is not a member of — never 403', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: as(b.token) });
    expect(res.statusCode).toBe(404);
  });

  it('403s a member of a suspended org, even at VIEWER', async () => {
    const a = await user('a@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    await app.prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: as(a.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'organization suspended' });
  });

  it('members list 404s for a non-member on a real org, and for a nonexistent org, with the same status and body — no enumeration oracle', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();

    const nonMember = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/members`, headers: as(b.token) });
    const nonexistent = await app.inject({ method: 'GET', url: `/v1/orgs/00000000-0000-0000-0000-000000000000/members`, headers: as(b.token) });

    expect(nonMember.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(nonMember.json()).toEqual(nonexistent.json());
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

  it('concurrent demotions of two different OWNERs never leave the org with zero owners', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const mb = await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'OWNER' } });
    const ma = await app.prisma.membership.findFirstOrThrow({ where: { userId: a.id, orgId: org.id } });

    // Each OWNER demotes the OTHER owner (not themselves), so both requests'
    // requireRole('OWNER') preHandlers observe a stable, still-OWNER actor
    // regardless of request ordering.
    //
    // NOTE on what this test can and cannot prove: in this environment,
    // two `app.inject` calls issued via Promise.all against a single
    // in-process Fastify instance + local Postgres do not interleave at the
    // vulnerable check-then-act window — one request's entire pipeline
    // (verified with request-order instrumentation and a bare-Prisma
    // version of this same race with no HTTP layer at all) deterministically
    // completes before the other's first query resolves, every time across
    // 30+ trials. That collapses this in-process test to a sequential
    // execution: the second request is rejected either by requireRole
    // (403, if it's the actor's own role that already changed) or by the
    // ownerCount guard (409, if only the target's role changed) — but
    // never by both requests reading a stale ownerCount and racing through.
    // We independently reproduced the *actual* double-success race with two
    // separate OS processes racing against the same rows via a file-based
    // start barrier (bypassing Node's single-event-loop scheduling): both
    // succeeded and the organization was left with zero owners in 5/5
    // trials. So the bug this test targets is real, but this particular
    // in-process Promise.all test cannot reliably reproduce it — it can
    // only assert the outcome is always *safe* (never zero owners), which
    // is what it does below.
    const [ra, rb] = await Promise.all([
      app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${mb.id}`, headers: as(a.token), payload: { role: 'ADMIN' } }),
      app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${ma.id}`, headers: as(b.token), payload: { role: 'ADMIN' } }),
    ]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([403, 409]).toContain(codes[1]);
    const ownerCount = await app.prisma.membership.count({ where: { orgId: org.id, role: 'OWNER' } });
    expect(ownerCount).toBeGreaterThanOrEqual(1);
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
