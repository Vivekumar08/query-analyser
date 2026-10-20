import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { settledOrBlocked } from '../test/locks.js';
import { limitsFor } from '../plans.js';
import { loadConfig } from '../config.js';
import { lockOrg, lockOwnersAndTarget } from './locks.js';
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
  await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
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

  it('never hands out a reserved slug', async () => {
    const u = await user('o@x.io');
    for (const [name, base] of [['Account', 'account'], ['New', 'new'], ['new!', 'new']] as const) {
      const res = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name } });
      expect(res.statusCode).toBe(201);
      expect(res.json().slug).toMatch(new RegExp(`^${base}-[a-z0-9]{4}$`));
      // Three orgs for one owner is past the free limit, so the first is on team.
      if (base === 'account') await app.prisma.organization.update({ where: { id: res.json().id }, data: { plan: 'team' } });
    }
  });

  it('suffixes a colliding slug', async () => {
    const u = await user('o@x.io');
    const first = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme' } });
    expect(first.statusCode).toBe(201);
    expect(first.json().slug).toBe('acme');
    // A second org for one owner is past the free limit.
    await app.prisma.organization.update({ where: { id: first.json().id }, data: { plan: 'team' } });

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
    // ADMIN is past the free plan's roles.
    await app.prisma.organization.update({ where: { id: org.id }, data: { plan: 'team' } });
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
    await app.prisma.organization.update({ where: { id: org.id }, data: { plan: 'team' } });
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

describe('org limit', () => {
  const create = (token: string, name = 'A') =>
    app.inject({ method: 'POST', url: '/v1/orgs', headers: as(token), payload: { name } });

  it('a free owner cannot create a second org', async () => {
    const u = await user('o@x.io');
    expect((await create(u.token, 'First')).statusCode).toBe(201);
    const res = await create(u.token, 'Second');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'plan-limit', limit: 'orgs', max: 1 });
    expect(await app.prisma.membership.count({ where: { userId: u.id, role: 'OWNER' } })).toBe(1);
  });

  it('being invited into other orgs does not count', async () => {
    const a = await user('a@x.io'); const u = await user('u@x.io');
    const other = (await create(a.token, 'Other')).json() as { id: string };
    await app.prisma.membership.create({ data: { userId: u.id, orgId: other.id, role: 'MEMBER' } });
    expect((await create(u.token, 'Mine')).statusCode).toBe(201);
  });

  it('the largest limit among orgs the user created applies', async () => {
    const u = await user('u@x.io');
    const first = (await create(u.token, 'One')).json() as { id: string };
    expect((await app.prisma.organization.findUniqueOrThrow({ where: { id: first.id } })).createdById).toBe(u.id);
    await app.prisma.organization.update({ where: { id: first.id }, data: { plan: 'team' } });
    expect((await create(u.token, 'Two')).statusCode).toBe(201);
    expect((await create(u.token, 'Three')).statusCode).toBe(201);
    const res = await create(u.token, 'Four');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'plan-limit', limit: 'orgs', max: 3 });
  });

  it('a free user promoted to OWNER of a team org still cannot create a second free org', async () => {
    const a = await user('a@x.io'); const u = await user('u@x.io');
    const team = (await create(a.token, 'Team')).json() as { id: string };
    await app.prisma.organization.update({ where: { id: team.id }, data: { plan: 'team' } });
    expect((await create(u.token, 'Mine')).statusCode).toBe(201);
    const m = await app.prisma.membership.create({ data: { userId: u.id, orgId: team.id, role: 'MEMBER' } });
    expect((await app.inject({ method: 'PATCH', url: `/v1/orgs/${team.id}/members/${m.id}`, headers: as(a.token), payload: { role: 'OWNER' } })).statusCode).toBe(200);
    const res = await create(u.token, 'Mine2');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'plan-limit', limit: 'orgs', max: 1 });
  });

  it('two concurrent creates by a free user make exactly one org', async () => {
    const u = await user('u@x.io');
    const [r1, r2] = await Promise.all([create(u.token, 'One'), create(u.token, 'Two')]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 403]);
    expect(await app.prisma.membership.count({ where: { userId: u.id, role: 'OWNER' } })).toBe(1);
  });

  it('a create waits on the user-row lock, then sees the org created meanwhile', async () => {
    // In-process Promise.all doesn't reliably interleave (see the demotion
    // test above), so pin the lock: this transaction plays a concurrent
    // create by the same user, holding their User row.
    const u = await user('u@x.io');
    let res: Promise<{ statusCode: number; json: () => unknown }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${u.id} FOR NO KEY UPDATE`;
      res = create(u.token, 'Second');
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await tx.organization.create({ data: { name: 'First', slug: 'first', createdById: u.id, memberships: { create: { userId: u.id, role: 'OWNER' } } } });
    });
    const done = await res!;
    expect(done.statusCode).toBe(403);
    expect(done.json()).toEqual({ error: 'plan-limit', limit: 'orgs', max: 1 });
    expect(await app.prisma.organization.count({ where: { createdById: u.id } })).toBe(1);
  });

  it('lists each org with its plan limits', async () => {
    const u = await user('u@x.io');
    const org = (await create(u.token, 'Mine')).json() as { id: string };
    const list = await app.inject({ method: 'GET', url: '/v1/orgs', headers: as(u.token) });
    // Inside the default retention grace (until 2027-01-31) free keeps 90 days.
    expect(list.json()).toEqual([expect.objectContaining({
      id: org.id, plan: 'free', role: 'OWNER', limits: { ...limitsFor('free'), dailyRetentionDays: 90 },
    })]);
  });

  it('marks which listed orgs the caller created, not which they own (P1-1)', async () => {
    const a = await user('a@x.io');
    const b = await user('b@x.io');
    const mine = (await create(a.token, 'Mine')).json() as { id: string };
    // b is promoted to OWNER of a's org but created nothing.
    await app.prisma.membership.create({ data: { userId: b.id, orgId: mine.id, role: 'OWNER' } });
    const listA = (await app.inject({ method: 'GET', url: '/v1/orgs', headers: as(a.token) })).json();
    const listB = (await app.inject({ method: 'GET', url: '/v1/orgs', headers: as(b.token) })).json();
    expect(listA).toEqual([expect.objectContaining({ id: mine.id, role: 'OWNER', createdByMe: true })]);
    expect(listB).toEqual([expect.objectContaining({ id: mine.id, role: 'OWNER', createdByMe: false })]);
    // The creator's id itself is never sent.
    expect(listB[0]).not.toHaveProperty('createdById');
  });

  it('lists the plan\'s own retention once the grace has passed', async () => {
    const after = await buildApp({ logger: false, config: { ...loadConfig(), RETENTION_GRACE_UNTIL: new Date('2026-01-01T00:00:00.000Z') } });
    try {
      const u = await user('g@x.io');
      const org = (await create(u.token, 'Mine')).json() as { id: string };
      await app.prisma.organization.create({
        data: { name: 'Big', slug: 'big', plan: 'team', memberships: { create: { userId: u.id, role: 'MEMBER' } } },
      });
      const list = await after.inject({ method: 'GET', url: '/v1/orgs', headers: as(u.token) });
      expect(list.json()).toEqual([
        expect.objectContaining({ id: org.id, limits: limitsFor('free') }),
        expect.objectContaining({ slug: 'big', limits: limitsFor('team') }),
      ]);
      expect(limitsFor('free').dailyRetentionDays).toBe(30);
    } finally {
      await after.close();
    }
  });
});

describe('leave', () => {
  const leave = (orgId: string, token: string) =>
    app.inject({ method: 'DELETE', url: `/v1/orgs/${orgId}/membership`, headers: as(token) });

  async function orgOwnedBy(token: string) {
    return (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(token), payload: { name: 'A' } })).json() as { id: string };
  }

  it('a MEMBER or VIEWER leaves: 204, membership gone, the org then 404s for them', async () => {
    const a = await user('a@x.io');
    const org = await orgOwnedBy(a.token);
    for (const [email, role] of [['m@x.io', 'MEMBER'], ['v@x.io', 'VIEWER']] as const) {
      const u = await user(email);
      await app.prisma.membership.create({ data: { userId: u.id, orgId: org.id, role } });

      const res = await leave(org.id, u.token);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(await app.prisma.membership.findUnique({ where: { userId_orgId: { userId: u.id, orgId: org.id } } })).toBeNull();
      expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: as(u.token) })).statusCode).toBe(404);
      expect((await leave(org.id, u.token)).statusCode).toBe(404);
    }
    // The owner is untouched.
    expect(await app.prisma.membership.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('the only OWNER cannot leave', async () => {
    const a = await user('a@x.io');
    const org = await orgOwnedBy(a.token);
    // Other, non-owner members don't count towards keeping an owner.
    const b = await user('b@x.io');
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'ADMIN' } });

    const res = await leave(org.id, a.token);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'organization must keep at least one owner' });
    const still = await app.prisma.membership.findUnique({ where: { userId_orgId: { userId: a.id, orgId: org.id } } });
    expect(still?.role).toBe('OWNER');
  });

  it('an OWNER can leave when another OWNER remains', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = await orgOwnedBy(a.token);
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'OWNER' } });

    expect((await leave(org.id, a.token)).statusCode).toBe(204);
    const owners = await app.prisma.membership.findMany({ where: { orgId: org.id, role: 'OWNER' } });
    expect(owners.map((m) => m.userId)).toEqual([b.id]);
  });

  it('404s a non-member and a nonexistent org alike', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = await orgOwnedBy(a.token);

    const nonMember = await leave(org.id, b.token);
    const nonexistent = await leave('00000000-0000-0000-0000-000000000000', b.token);
    expect(nonMember.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(nonMember.json()).toEqual(nonexistent.json());
    expect(await app.prisma.membership.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('403s leaving a suspended org', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = await orgOwnedBy(a.token);
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'MEMBER' } });
    await app.prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });

    const res = await leave(org.id, b.token);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'organization suspended' });
    expect(await app.prisma.membership.count({ where: { orgId: org.id } })).toBe(2);
  });

  it('two OWNERs leaving at once never leave the org ownerless', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = await orgOwnedBy(a.token);
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'OWNER' } });

    const [ra, rb] = await Promise.all([leave(org.id, a.token), leave(org.id, b.token)]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([204, 409]);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, role: 'OWNER' } })).toBe(1);
  });

  it('an OWNER leaving waits on the owner-row lock, then sees the other owner already gone', async () => {
    // In-process Promise.all doesn't reliably interleave (see the demotion
    // test above), so pin the lock directly: this transaction plays the
    // other owner's concurrent leave, holding the OWNER rows.
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = await orgOwnedBy(a.token);
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'OWNER' } });

    let res: Promise<{ statusCode: number; json: () => unknown }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Membership" WHERE "orgId" = ${org.id} AND role = 'OWNER'::"Role" ORDER BY id FOR UPDATE`;
      res = leave(org.id, b.token);
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await tx.membership.delete({ where: { userId_orgId: { userId: a.id, orgId: org.id } } });
    });
    const done = await res!;
    expect(done.statusCode).toBe(409);
    expect(done.json()).toEqual({ error: 'organization must keep at least one owner' });
    expect(await app.prisma.membership.count({ where: { orgId: org.id, role: 'OWNER' } })).toBe(1);
  });

  it('a caller promoted to OWNER mid-leave, while the other owner steps down, cannot leave the org ownerless', async () => {
    // a is the only OWNER; c is ADMIN. The holder transaction stands in for
    // two committed role changes (promote c, then a demotes themself) landing
    // between the leave's read of its own row and its delete.
    const a = await user('a@x.io'); const c = await user('c@x.io');
    const org = await orgOwnedBy(a.token);
    await app.prisma.membership.create({ data: { userId: c.id, orgId: org.id, role: 'ADMIN' } });

    let res: Promise<{ statusCode: number; json: () => unknown }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Membership" WHERE "orgId" = ${org.id} ORDER BY id FOR UPDATE`;
      res = leave(org.id, c.token);
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await tx.membership.update({ where: { userId_orgId: { userId: c.id, orgId: org.id } }, data: { role: 'OWNER' } });
      await tx.membership.update({ where: { userId_orgId: { userId: a.id, orgId: org.id } }, data: { role: 'ADMIN' } });
    });
    const done = await res!;
    expect(done.statusCode).toBe(409);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, role: 'OWNER' } })).toBe(1);
  });
});

describe('owner-row lock on role changes and removal', () => {
  // Same interleaving as the leave test above: the target c is ADMIN when
  // the request starts, then (in the holder) c is promoted and the acting
  // owner a steps down. Acting on c afterwards must not leave zero owners.
  async function orgWithAdmin() {
    const a = await user('a@x.io'); const c = await user('c@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json() as { id: string };
    // VIEWER is past the free plan's roles.
    await app.prisma.organization.update({ where: { id: org.id }, data: { plan: 'team' } });
    const mc = await app.prisma.membership.create({ data: { userId: c.id, orgId: org.id, role: 'ADMIN' } });
    return { a, c, org, mc };
  }

  async function promoteTargetAndStepDownMidRequest(
    orgId: string, a: { id: string }, c: { id: string },
    send: () => Promise<{ statusCode: number; json: () => unknown }>,
  ) {
    let res: Promise<{ statusCode: number; json: () => unknown }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Membership" WHERE "orgId" = ${orgId} ORDER BY id FOR UPDATE`;
      res = send();
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await tx.membership.update({ where: { userId_orgId: { userId: c.id, orgId } }, data: { role: 'OWNER' } });
      await tx.membership.update({ where: { userId_orgId: { userId: a.id, orgId } }, data: { role: 'ADMIN' } });
    });
    return res!;
  }

  it('removing a member promoted to OWNER mid-request, while the other owner steps down, 409s', async () => {
    const { a, c, org, mc } = await orgWithAdmin();
    const done = await promoteTargetAndStepDownMidRequest(org.id, a, c, () =>
      app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/members/${mc.id}`, headers: as(a.token) }));
    expect(done.statusCode).toBe(409);
    expect(done.json()).toEqual({ error: 'organization must keep at least one owner' });
    expect(await app.prisma.membership.count({ where: { orgId: org.id, role: 'OWNER' } })).toBe(1);
  });

  it('demoting a member promoted to OWNER mid-request, while the other owner steps down, 409s', async () => {
    const { a, c, org, mc } = await orgWithAdmin();
    const done = await promoteTargetAndStepDownMidRequest(org.id, a, c, () =>
      app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${mc.id}`, headers: as(a.token), payload: { role: 'VIEWER' } }));
    expect(done.statusCode).toBe(409);
    expect(done.json()).toEqual({ error: 'organization must keep at least one owner' });
    expect(await app.prisma.membership.count({ where: { orgId: org.id, role: 'OWNER' } })).toBe(1);
  });
});

describe('roles and app access', () => {
  type Res = { statusCode: number; json: () => any };
  // Invite creation is rate-limited per req.ip (10/minute); give each its own.
  let inviteIp = 0;
  const patch = (orgId: string, memberId: string, token: string, role: string): Promise<Res> =>
    app.inject({ method: 'PATCH', url: `/v1/orgs/${orgId}/members/${memberId}`, headers: as(token), payload: { role } });
  const remove = (orgId: string, memberId: string, token: string): Promise<Res> =>
    app.inject({ method: 'DELETE', url: `/v1/orgs/${orgId}/members/${memberId}`, headers: as(token) });
  const leave = (orgId: string, token: string): Promise<Res> =>
    app.inject({ method: 'DELETE', url: `/v1/orgs/${orgId}/membership`, headers: as(token) });
  const invite = (orgId: string, token: string, payload: { email: string; role: string; appId?: string }): Promise<Res> =>
    app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/invites`, headers: as(token), remoteAddress: `10.1.0.${++inviteIp}`, payload });
  const accept = (inviteToken: string, token: string): Promise<Res> =>
    app.inject({ method: 'POST', url: `/v1/invites/${inviteToken}/accept`, headers: as(token) });
  const getApp = (appId: string, token: string): Promise<Res> =>
    app.inject({ method: 'GET', url: `/v1/apps/${appId}`, headers: as(token) });

  async function orgOf(ownerEmail: string, plan: 'free' | 'team') {
    const o = await user(ownerEmail);
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(o.token), payload: { name: ownerEmail } })).json() as { id: string };
    if (plan !== 'free') await app.prisma.organization.update({ where: { id: org.id }, data: { plan } });
    return { o, org };
  }
  // Explicit, increasing createdAt so "ordered by app createdAt" is deterministic.
  let appSeq = 0;
  const newApp = (orgId: string, name: string) =>
    app.prisma.app.create({ data: { orgId, name, env: 'production', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++appSeq)) } });
  const member = (userId: string, orgId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER') =>
    app.prisma.membership.create({ data: { userId, orgId, role } });
  const grant = (userId: string, appIds: string[], role: 'MEMBER' | 'VIEWER') =>
    app.prisma.appAccess.createMany({ data: appIds.map((appId) => ({ appId, userId, role })) });
  const rowsIn = (userId: string, orgId: string) =>
    app.prisma.appAccess.findMany({ where: { userId, app: { orgId } }, select: { appId: true, role: true }, orderBy: { appId: 'asc' } });

  it('free: a member can only be made OWNER; ADMIN and VIEWER are refused as role', async () => {
    const { o, org } = await orgOf('o@x.io', 'free');
    const u = await user('u@x.io');
    const m = await member(u.id, org.id, 'MEMBER');
    for (const role of ['ADMIN', 'VIEWER']) {
      const res = await patch(org.id, m.id, o.token, role);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'plan-limit', limit: 'role', max: 1 });
      expect((await app.prisma.membership.findUniqueOrThrow({ where: { id: m.id } })).role).toBe('MEMBER');
    }
    const res = await patch(org.id, m.id, o.token, 'OWNER');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: m.id, role: 'OWNER' });
  });

  it('setting the current role is always allowed (grandfathered VIEWER on free)', async () => {
    const { o, org } = await orgOf('o@x.io', 'free');
    const u = await user('u@x.io');
    const m = await member(u.id, org.id, 'VIEWER');
    const res = await patch(org.id, m.id, o.token, 'VIEWER');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: m.id, role: 'VIEWER' });
  });

  it('promotion to ADMIN or OWNER drops their rows in this org only', async () => {
    const { o, org } = await orgOf('o@x.io', 'team');
    const { org: other } = await orgOf('p@x.io', 'team');
    const [shop, admin, elsewhere] = [await newApp(org.id, 'Shop'), await newApp(org.id, 'Admin panel'), await newApp(other.id, 'Else')];
    for (const [email, role] of [['m1@x.io', 'ADMIN'], ['m2@x.io', 'OWNER']] as const) {
      const u = await user(email);
      const m = await member(u.id, org.id, 'MEMBER');
      await member(u.id, other.id, 'MEMBER');
      await grant(u.id, [shop.id, admin.id, elsewhere.id], 'MEMBER');

      expect((await patch(org.id, m.id, o.token, role)).statusCode).toBe(200);
      expect(await rowsIn(u.id, org.id)).toEqual([]);
      expect(await rowsIn(u.id, other.id)).toEqual([{ appId: elsewhere.id, role: 'MEMBER' }]);
    }
  });

  it('demotion to MEMBER or VIEWER grants every current app with the new role', async () => {
    const { o, org } = await orgOf('o@x.io', 'team');
    const apps = [await newApp(org.id, 'Shop'), await newApp(org.id, 'Admin panel')];
    const expected = (role: string) => apps.map((a) => ({ appId: a.id, role })).sort((x, y) => x.appId.localeCompare(y.appId));
    for (const [email, from, to] of [['a@x.io', 'ADMIN', 'MEMBER'], ['b@x.io', 'OWNER', 'VIEWER']] as const) {
      const u = await user(email);
      const m = await member(u.id, org.id, from);
      expect((await patch(org.id, m.id, o.token, to)).statusCode).toBe(200);
      expect(await rowsIn(u.id, org.id)).toEqual(expected(to));
    }
  });

  it('MEMBER → VIEWER moves every row to VIEWER, and back', async () => {
    const { o, org } = await orgOf('o@x.io', 'team');
    const [shop, admin] = [await newApp(org.id, 'Shop'), await newApp(org.id, 'Admin panel')];
    await newApp(org.id, 'Not theirs');
    const u = await user('u@x.io');
    const m = await member(u.id, org.id, 'MEMBER');
    await grant(u.id, [shop.id, admin.id], 'MEMBER');
    const ids = [shop.id, admin.id].sort();

    expect((await patch(org.id, m.id, o.token, 'VIEWER')).statusCode).toBe(200);
    expect(await rowsIn(u.id, org.id)).toEqual(ids.map((appId) => ({ appId, role: 'VIEWER' })));
    expect((await patch(org.id, m.id, o.token, 'MEMBER')).statusCode).toBe(200);
    expect(await rowsIn(u.id, org.id)).toEqual(ids.map((appId) => ({ appId, role: 'MEMBER' })));
  });

  it('being made OWNER ignores the target\'s owned-org limit', async () => {
    const { o, org } = await orgOf('o@x.io', 'free');
    const { o: u } = await orgOf('u@x.io', 'free'); // u already owns their own free org
    const m = await member(u.id, org.id, 'MEMBER');
    expect((await patch(org.id, m.id, o.token, 'OWNER')).statusCode).toBe(200);
    expect(await app.prisma.membership.count({ where: { userId: u.id, role: 'OWNER' } })).toBe(2);
  });

  it('removing a member and leaving both delete their rows in that org', async () => {
    const { o, org } = await orgOf('o@x.io', 'team');
    const { org: other } = await orgOf('p@x.io', 'team');
    const [shop, elsewhere] = [await newApp(org.id, 'Shop'), await newApp(other.id, 'Else')];
    const r = await user('r@x.io'); const l = await user('l@x.io');
    const mr = await member(r.id, org.id, 'MEMBER');
    await member(l.id, org.id, 'VIEWER');
    for (const u of [r, l]) {
      await member(u.id, other.id, 'MEMBER');
      await grant(u.id, [shop.id, elsewhere.id], 'MEMBER');
    }

    expect((await remove(org.id, mr.id, o.token)).statusCode).toBe(204);
    expect((await leave(org.id, l.token)).statusCode).toBe(204);
    for (const u of [r, l]) {
      expect(await rowsIn(u.id, org.id)).toEqual([]);
      expect(await rowsIn(u.id, other.id)).toEqual([{ appId: elsewhere.id, role: 'MEMBER' }]);
    }
  });

  it('a removed member re-invited to a different app sees only that app', async () => {
    const { o, org } = await orgOf('o@x.io', 'team');
    const [shop, admin] = [await newApp(org.id, 'Shop'), await newApp(org.id, 'Admin panel')];
    const u = await user('u@x.io');
    expect((await accept((await invite(org.id, o.token, { email: 'u@x.io', role: 'MEMBER', appId: shop.id })).json().token, u.token)).statusCode).toBe(200);
    expect((await getApp(shop.id, u.token)).statusCode).toBe(200);

    const m = await app.prisma.membership.findUniqueOrThrow({ where: { userId_orgId: { userId: u.id, orgId: org.id } } });
    expect((await remove(org.id, m.id, o.token)).statusCode).toBe(204);
    expect((await accept((await invite(org.id, o.token, { email: 'u@x.io', role: 'MEMBER', appId: admin.id })).json().token, u.token)).statusCode).toBe(200);

    expect((await getApp(admin.id, u.token)).statusCode).toBe(200);
    const old = await getApp(shop.id, u.token);
    expect(old.statusCode).toBe(404);
    expect(old.json()).toEqual({ error: 'Not Found' });
  });

  // Ruling A5-1: an invite issued before an admin restricted someone must not
  // restore what was taken away.
  describe('pending invites go when the membership changes', () => {
    async function memberWithPendingInvite() {
      const { o, org } = await orgOf('o@x.io', 'team');
      const { o: p, org: other } = await orgOf('p@x.io', 'team');
      const [shop, admin, elsewhere] = [await newApp(org.id, 'Shop'), await newApp(org.id, 'Admin panel'), await newApp(other.id, 'Else')];
      const u = await user('u@x.io');
      const m = await member(u.id, org.id, 'MEMBER');
      await grant(u.id, [shop.id], 'MEMBER');
      // Issued in mixed case; stored lowercased.
      const pending = (await invite(org.id, o.token, { email: 'U@x.io', role: 'MEMBER', appId: admin.id })).json().token as string;
      const otherOrg = (await invite(other.id, p.token, { email: 'u@x.io', role: 'MEMBER', appId: elsewhere.id })).json().token as string;
      return { o, org, u, m, pending, otherOrg };
    }

    it('a demotion deletes them; accepting afterwards 404s', async () => {
      const { o, org, u, m, pending, otherOrg } = await memberWithPendingInvite();
      expect((await patch(org.id, m.id, o.token, 'VIEWER')).statusCode).toBe(200);
      expect((await accept(pending, u.token)).statusCode).toBe(404);
      expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(0);
      // Another org's invite is untouched.
      expect((await accept(otherOrg, u.token)).statusCode).toBe(200);
    });

    it('a promotion deletes them too', async () => {
      const { o, org, u, m, pending } = await memberWithPendingInvite();
      expect((await patch(org.id, m.id, o.token, 'ADMIN')).statusCode).toBe(200);
      expect((await accept(pending, u.token)).statusCode).toBe(404);
    });

    it('removal deletes them; accepting afterwards 404s', async () => {
      const { o, org, u, m, pending, otherOrg } = await memberWithPendingInvite();
      expect((await remove(org.id, m.id, o.token)).statusCode).toBe(204);
      expect((await accept(pending, u.token)).statusCode).toBe(404);
      expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: u.id } })).toBe(0);
      expect((await accept(otherOrg, u.token)).statusCode).toBe(200);
    });

    it('leaving deletes them; accepting afterwards 404s', async () => {
      const { org, u, pending, otherOrg } = await memberWithPendingInvite();
      expect((await leave(org.id, u.token)).statusCode).toBe(204);
      expect((await accept(pending, u.token)).statusCode).toBe(404);
      expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: u.id } })).toBe(0);
      expect((await accept(otherOrg, u.token)).statusCode).toBe(200);
    });
  });

  it('lists each member with their apps', async () => {
    const { o, org } = await orgOf('o@x.io', 'team');
    const { org: other } = await orgOf('p@x.io', 'team');
    const shop = await newApp(org.id, 'Shop');
    const admin = await newApp(org.id, 'Admin panel');
    await newApp(org.id, 'Not theirs');
    const elsewhere = await newApp(other.id, 'Else');
    const u = await user('u@x.io');
    const m = await member(u.id, org.id, 'MEMBER');
    await member(u.id, other.id, 'MEMBER');
    // Inserted out of app order; listed by app createdAt.
    await app.prisma.appAccess.create({ data: { appId: admin.id, userId: u.id, role: 'VIEWER' } });
    await app.prisma.appAccess.create({ data: { appId: elsewhere.id, userId: u.id, role: 'MEMBER' } });
    await app.prisma.appAccess.create({ data: { appId: shop.id, userId: u.id, role: 'MEMBER' } });

    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/members`, headers: as(o.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ role: 'OWNER', user: { id: o.id, email: 'o@x.io', name: 'o@x.io' }, allApps: true, apps: [] }),
      {
        id: m.id, role: 'MEMBER', createdAt: m.createdAt.toISOString(),
        user: { id: u.id, email: 'u@x.io', name: 'u@x.io' },
        allApps: false,
        apps: [{ id: shop.id, name: 'Shop', role: 'MEMBER' }, { id: admin.id, name: 'Admin panel', role: 'VIEWER' }],
      },
    ]);
  });

  // Accept takes the org lock, then the membership locks. A role change,
  // removal or leave that locked the membership rows first and the org second
  // would deadlock against it. Pin it: the holder plays an accept that holds
  // the org row and then asks for the owner and target rows.
  it('a role change, removal or leave behind an accept\'s org lock waits, then completes without deadlock', async () => {
    const { o, org } = await orgOf('o@x.io', 'team');
    const shop = await newApp(org.id, 'Shop');
    const n = await user('n@x.io');
    const cases: [string, (m: { id: string }, token: string) => Promise<Res>, number][] = [
      ['p@x.io', (m) => patch(org.id, m.id, o.token, 'VIEWER'), 200],
      ['r@x.io', (m) => remove(org.id, m.id, o.token), 204],
      ['l@x.io', (_m, token) => leave(org.id, token), 204],
    ];
    for (const [email, send, status] of cases) {
      const u = await user(email);
      const m = await member(u.id, org.id, 'MEMBER');
      await grant(u.id, [shop.id], 'MEMBER');
      let res: Promise<Res> | undefined;
      await app.prisma.$transaction(async (tx) => {
        await lockOrg(tx, org.id);
        res = send(m, u.token);
        expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
        await lockOwnersAndTarget(tx, org.id, { userId: n.id });
      });
      expect((await res!).statusCode).toBe(status);
    }
  });
});
