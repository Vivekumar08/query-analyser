import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { settledOrBlocked } from '../test/locks.js';
import { lockOrg, lockOwnersAndTarget } from '../orgs/locks.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
type Res = { statusCode: number; json: () => any };
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';
const HOUR = 3600_000;

const ingestBody = (n: number) => ({
  app: 'shop', env: 'production', host: 'h', sdkVersion: '0.1.0', bucket: '2026092014', thresholdMs: 100, dropped: 0,
  items: Array.from({ length: n }, (_, i) => ({
    signature: `S${i}`, hash: i.toString(16).padStart(16, '0'), model: 'M', operation: 'find',
    filterShape: [], sortKeys: [], stages: [], count: 1, totalMs: 120, maxMs: 120, lastMs: 120, lastTs: 1,
    hist: [0, 1, 0, 0, 0, 0, 0, 0], sample: null,
  })),
});

// Signup is rate-limited per IP; give each fixture signup its own address.
let nextIp = 1;
const signupIp = () => `10.7.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;

async function user(email: string) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', remoteAddress: signupIp(), payload: { email, password: 'correct horse battery', name: email } });
  await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  return { id: s.json().user.id as string, h: { authorization: `Bearer ${s.json().accessToken as string}` } };
}

/** An org owned by `o@x.io` on `plan`, with two apps (one on free, which allows one). */
async function org(plan = 'team', email = 'o@x.io') {
  const o = await user(email);
  const created = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: `Org ${email}` } })).json();
  const orgId = created.id as string;
  await app.prisma.organization.update({ where: { id: orgId }, data: { plan: 'team' } });
  const shop = (await app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/apps`, headers: o.h, payload: { name: 'shop', env: 'production' } })).json().id as string;
  const other = plan === 'free' ? '' : (await app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/apps`, headers: o.h, payload: { name: 'other', env: 'production' } })).json().id as string;
  await app.prisma.organization.update({ where: { id: orgId }, data: { plan } });
  return { o, orgId, shop, other };
}

async function member(orgId: string, role: Role, email: string) {
  const u = await user(email);
  const m = await app.prisma.membership.create({ data: { userId: u.id, orgId, role } });
  return { ...u, membershipId: m.id };
}

const grant = (appId: string, userId: string, role: 'MEMBER' | 'VIEWER' = 'MEMBER') =>
  app.prisma.appAccess.create({ data: { appId, userId, role } });

async function invite(orgId: string, appId: string | null, email: string, role: Role, opts: { expiresAt?: Date; acceptedAt?: Date } = {}) {
  const token = randomBytes(16).toString('hex');
  const row = await app.prisma.invite.create({
    data: {
      orgId, appId, email, role,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + HOUR),
      acceptedAt: opts.acceptedAt ?? null,
    },
  });
  return { id: row.id, token };
}

const getAccess = (appId: string, h: Record<string, string>) => app.inject({ method: 'GET', url: `/v1/apps/${appId}/access`, headers: h });
const revoke = (appId: string, userId: string, h: Record<string, string>) => app.inject({ method: 'DELETE', url: `/v1/apps/${appId}/access/${userId}`, headers: h });
const deleteApp = (appId: string, h: Record<string, string>) => app.inject({ method: 'DELETE', url: `/v1/apps/${appId}`, headers: h });
const accept = (token: string, h: Record<string, string>) => app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: h });
const patchRole = (orgId: string, membershipId: string, role: Role, h: Record<string, string>) =>
  app.inject({ method: 'PATCH', url: `/v1/orgs/${orgId}/members/${membershipId}`, headers: h, payload: { role } });

describe('GET /v1/apps/:id/access', () => {
  it('lists owners/admins as all-apps, row holders, this app\'s pending invites and seats', async () => {
    const { o, orgId, shop, other } = await org();
    const a = await member(orgId, 'ADMIN', 'a@x.io');
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    await grant(shop, m.id, 'MEMBER');
    await grant(other, m.id, 'VIEWER');
    const v = await member(orgId, 'VIEWER', 'v@x.io');
    await grant(other, v.id, 'VIEWER');
    const n1 = await invite(orgId, shop, 'n1@x.io', 'MEMBER');
    await invite(orgId, other, 'n2@x.io', 'MEMBER');
    await invite(orgId, shop, 'n3@x.io', 'VIEWER', { expiresAt: new Date(Date.now() - HOUR) });
    await invite(orgId, null, 'n4@x.io', 'ADMIN');
    await invite(orgId, shop, 'n5@x.io', 'MEMBER', { acceptedAt: new Date() });

    // Another org's people, rows and invites never show up here.
    const x = await org('team', 'x@x.io');
    const xm = await member(x.orgId, 'MEMBER', 'xm@x.io');
    await grant(x.shop, xm.id);
    await invite(x.orgId, x.shop, 'xn@x.io', 'MEMBER');

    const res = await getAccess(shop, o.h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      people: [
        { userId: o.id, name: 'o@x.io', email: 'o@x.io', role: 'OWNER', allApps: true },
        { userId: a.id, name: 'a@x.io', email: 'a@x.io', role: 'ADMIN', allApps: true },
        { userId: m.id, name: 'm@x.io', email: 'm@x.io', role: 'MEMBER', allApps: false },
      ],
      invites: [{ id: n1.id, email: 'n1@x.io', role: 'MEMBER', expiresAt: expect.any(String) }],
      seats: { used: 6, max: 20 }, // o a m v + n1 n2 n4 − 1 (n3 expired, n5 accepted)
    });

    // The app role is the row's, not the membership's.
    const otherRes = (await getAccess(other, a.h)).json();
    expect(otherRes.people.filter((p: { allApps: boolean }) => !p.allApps)).toEqual([
      { userId: m.id, name: 'm@x.io', email: 'm@x.io', role: 'VIEWER', allApps: false },
      { userId: v.id, name: 'v@x.io', email: 'v@x.io', role: 'VIEWER', allApps: false },
    ]);
  });

  it('seats.max follows the org\'s plan', async () => {
    const { o, shop } = await org('free');
    expect((await getAccess(shop, o.h)).json().seats).toEqual({ used: 0, max: 1 });
  });

  it('leaves out a row holder who is no longer a member of the org', async () => {
    const { o, orgId, shop } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    await grant(shop, m.id);
    // The database doesn't tie a row to a membership; an orphan row (left by
    // some older path) must not list a non-member's email here.
    const orphan = await user('gone@x.io');
    await grant(shop, orphan.id);
    const elsewhere = await org('team', 'x@x.io');
    await app.prisma.membership.create({ data: { userId: orphan.id, orgId: elsewhere.orgId, role: 'MEMBER' } });
    const res = (await getAccess(shop, o.h)).json();
    expect(res.people.map((p: { email: string }) => p.email)).toEqual(['o@x.io', 'm@x.io']);
    expect(res.seats).toEqual({ used: 1, max: 20 });
  });

  it('403s a MEMBER with a row and 404s one without', async () => {
    const { orgId, shop, other } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    await grant(shop, m.id, 'MEMBER');
    const refused = await getAccess(shop, m.h);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'insufficient role' });
    const hidden = await getAccess(other, m.h);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'Not Found' });
  });

  it('404s a foreign or unknown app alike', async () => {
    const { shop } = await org();
    const x = await org('team', 'x@x.io');
    const foreign = await getAccess(shop, x.o.h);
    const unknown = await getAccess(NONEXISTENT, x.o.h);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
  });
});

describe('DELETE /v1/apps/:id/access/:userId', () => {
  it('removes the row only; the membership stays and still counts as a seat', async () => {
    const { o, orgId, shop, other } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    await grant(shop, m.id);
    await grant(other, m.id);
    const before = (await getAccess(shop, o.h)).json().seats;

    const res = await revoke(shop, m.id, o.h);
    expect(res.statusCode).toBe(204);
    expect(await app.prisma.appAccess.findMany({ where: { userId: m.id }, select: { appId: true } })).toEqual([{ appId: other }]);
    expect(await app.prisma.membership.count({ where: { orgId, userId: m.id } })).toBe(1);
    expect((await getAccess(shop, o.h)).json().seats).toEqual(before);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${shop}`, headers: m.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${other}`, headers: m.h })).statusCode).toBe(200);
  });

  it('also deletes their pending invites to that app, and only those (Ruling A5-1)', async () => {
    const { o, orgId, shop, other } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    // A user email from some other source may not be lowercased; invites are.
    await app.prisma.user.update({ where: { id: m.id }, data: { email: 'M@x.io' } });
    await grant(shop, m.id, 'VIEWER');
    const toShop = await invite(orgId, shop, 'm@x.io', 'MEMBER');
    const toOther = await invite(orgId, other, 'm@x.io', 'MEMBER');
    const someoneElse = await invite(orgId, shop, 'n@x.io', 'MEMBER');

    expect((await revoke(shop, m.id, o.h)).statusCode).toBe(204);
    const left = (await app.prisma.invite.findMany({ select: { id: true } })).map((i) => i.id).sort();
    expect(left).toEqual([toOther.id, someoneElse.id].sort());
    expect(left).not.toContain(toShop.id);
  });

  it('404s when there is no row, including for an OWNER', async () => {
    const { o, orgId, shop, other } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    await grant(other, m.id);
    const pending = await invite(orgId, shop, 'm@x.io', 'MEMBER');
    for (const userId of [m.id, o.id, NONEXISTENT]) {
      const res = await revoke(shop, userId, o.h);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found' });
    }
    expect(await app.prisma.appAccess.count({ where: { userId: m.id } })).toBe(1);
    expect(await app.prisma.invite.count({ where: { id: pending.id } })).toBe(1);
  });

  it('404s a userId that is not an id', async () => {
    const { o, shop } = await org();
    for (const userId of ['not-an-id', 'x'.repeat(80), '%27%20OR%201%3D1']) {
      const res = await revoke(shop, userId, o.h);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found' });
    }
  });

  it('waits on the org lock, so it sees a row an accept is granting', async () => {
    // The holder plays an accept granting m a row on shop under the org lock.
    // A revoke that didn't take the lock would see no row (404) and the
    // accept would then commit access the admin had just asked to remove.
    const { o, orgId, shop } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    let res: Promise<Res> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await lockOrg(tx, orgId);
      res = revoke(shop, m.id, o.h);
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await tx.appAccess.create({ data: { appId: shop, userId: m.id, role: 'MEMBER' } });
    });
    expect((await res!).statusCode).toBe(204);
    expect(await app.prisma.appAccess.count({ where: { userId: m.id } })).toBe(0);
  });

  it('403s a MEMBER with a row, 404s a foreign or unknown app alike', async () => {
    const { orgId, shop } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    await grant(shop, m.id);
    const refused = await revoke(shop, m.id, m.h);
    expect(refused.statusCode).toBe(403);
    const x = await org('team', 'x@x.io');
    const foreign = await revoke(shop, m.id, x.o.h);
    const unknown = await revoke(NONEXISTENT, m.id, x.o.h);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    expect(await app.prisma.appAccess.count({ where: { userId: m.id } })).toBe(1);
  });
});

describe('DELETE /v1/apps/:id', () => {
  it('deletes the app with its keys, signatures, rows and app invites; org-wide invites and memberships stay', async () => {
    const { o, orgId, shop, other } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    await grant(shop, m.id);
    await grant(other, m.id);
    expect((await app.inject({ method: 'POST', url: `/v1/apps/${shop}/keys`, headers: o.h })).statusCode).toBe(201);
    await app.prisma.querySignature.create({
      data: { appId: shop, hash: 'h', signature: 's', model: 'M', operation: 'find', filterShape: {}, sortKeys: [], stages: [] },
    });
    const toShop = await invite(orgId, shop, 'n1@x.io', 'MEMBER');
    const toOther = await invite(orgId, other, 'n2@x.io', 'MEMBER');
    const orgWide = await invite(orgId, null, 'n4@x.io', 'ADMIN');

    const res = await deleteApp(shop, o.h);
    expect(res.statusCode).toBe(204);
    expect(await app.prisma.app.findMany({ where: { orgId }, select: { id: true } })).toEqual([{ id: other }]);
    expect(await app.prisma.ingestKey.count({ where: { appId: shop } })).toBe(0);
    expect(await app.prisma.querySignature.count({ where: { appId: shop } })).toBe(0);
    expect(await app.prisma.appAccess.findMany({ where: { userId: m.id }, select: { appId: true } })).toEqual([{ appId: other }]);
    const invites = (await app.prisma.invite.findMany({ select: { id: true } })).map((i) => i.id).sort();
    expect(invites).toEqual([toOther.id, orgWide.id].sort());
    expect(invites).not.toContain(toShop.id);
    expect(await app.prisma.membership.count({ where: { orgId } })).toBe(2);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${shop}`, headers: o.h })).statusCode).toBe(404);
  });

  it('its ingest key is refused at once (Review Focus)', async () => {
    const { o, shop } = await org();
    const { key } = (await app.inject({ method: 'POST', url: `/v1/apps/${shop}/keys`, headers: o.h })).json();
    const body = { app: 'shop', env: 'production', host: 'h', sdkVersion: '0.1.0', bucket: '2026092014', thresholdMs: 100, dropped: 0, items: [] };
    // Warms the KeyResolver cache with this key.
    expect((await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: body })).statusCode).toBe(202);
    expect((await deleteApp(shop, o.h)).statusCode).toBe(204);
    const after = await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: body });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: 'invalid ingest key' });
  });

  it('a stale cached key for a deleted app gets 401, not 500, and is evicted (A7-1)', async () => {
    // Another replica deleted the app, so this process's cache was never
    // invalidated; or this request resolved its key just before the delete.
    const { o, shop } = await org();
    const { key } = (await app.inject({ method: 'POST', url: `/v1/apps/${shop}/keys`, headers: o.h })).json();
    const ingest = (n: number) => app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: ingestBody(n) });
    expect((await ingest(1)).statusCode).toBe(202); // cache warm
    const before = app.ingestStats.rejected401;
    await app.prisma.app.delete({ where: { id: shop } }); // bypasses invalidate
    const r = await ingest(2); // items present, so it reaches writeBatch
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'invalid ingest key' });
    expect(app.ingestStats.rejected401).toBe(before + 1);
    // Evicted: the next request re-resolves from the database and 401s
    // before writeBatch (a stale cache would 202 an empty batch).
    expect((await ingest(0)).statusCode).toBe(401);
  });

  it('403s a MEMBER, 404s a foreign or unknown app alike', async () => {
    const { orgId, shop } = await org();
    const m = await member(orgId, 'MEMBER', 'm@x.io');
    await grant(shop, m.id);
    const refused = await deleteApp(shop, m.h);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'insufficient role' });
    const x = await org('team', 'x@x.io');
    const foreign = await deleteApp(shop, x.o.h);
    const unknown = await deleteApp(NONEXISTENT, x.o.h);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    expect(foreign.json()).toEqual({ error: 'Not Found' });
    expect(await app.prisma.app.count({ where: { id: shop } })).toBe(1);
  });

  it('lets an ADMIN delete an app', async () => {
    const { orgId, shop } = await org();
    const a = await member(orgId, 'ADMIN', 'a@x.io');
    expect((await deleteApp(shop, a.h)).statusCode).toBe(204);
    expect(await app.prisma.app.count({ where: { id: shop } })).toBe(0);
  });

  it('frees the free plan\'s app slot', async () => {
    const { o, orgId, shop } = await org('free');
    const blocked = await app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/apps`, headers: o.h, payload: { name: 'next', env: 'production' } });
    expect(blocked.statusCode).toBe(403);
    expect((await deleteApp(shop, o.h)).statusCode).toBe(204);
    const res = await app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/apps`, headers: o.h, payload: { name: 'next', env: 'production' } });
    expect(res.statusCode).toBe(201);
  });

  // Lock order is the org row first. Deleting the app row and cascading
  // through its access rows and invites before taking the org lock would
  // deadlock against an accept (which holds the org lock and the claimed
  // invite, then inserts a row referencing the app), or let a demotion that
  // read the app list insert a row for an app that's gone (FK error, 500).
  describe('under the org lock', () => {
    it('a delete behind an accept holding the org lock and the claimed invite waits, then completes without deadlock', async () => {
      const { o, orgId, shop } = await org();
      const inv = await invite(orgId, shop, 'n@x.io', 'MEMBER');
      const n = await user('n@x.io');
      let res: Promise<Res> | undefined;
      await app.prisma.$transaction(async (tx) => {
        await lockOrg(tx, orgId);
        await tx.invite.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
        res = deleteApp(shop, o.h);
        expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
        await tx.membership.create({ data: { userId: n.id, orgId, role: 'MEMBER' } });
        await tx.appAccess.create({ data: { appId: shop, userId: n.id, role: 'MEMBER' } });
      });
      expect((await res!).statusCode).toBe(204);
      expect(await app.prisma.app.count({ where: { id: shop } })).toBe(0);
      expect(await app.prisma.appAccess.count({ where: { userId: n.id } })).toBe(0);
      expect(await app.prisma.membership.count({ where: { orgId, userId: n.id } })).toBe(1);
    });

    it('a delete behind a demotion that grants rows waits, then completes', async () => {
      const { o, orgId, shop, other } = await org();
      const a = await member(orgId, 'ADMIN', 'a@x.io');
      let res: Promise<Res> | undefined;
      await app.prisma.$transaction(async (tx) => {
        await lockOrg(tx, orgId);
        await lockOwnersAndTarget(tx, orgId, { id: a.membershipId });
        await tx.membership.update({ where: { id: a.membershipId }, data: { role: 'MEMBER' } });
        const apps = await tx.app.findMany({ where: { orgId }, select: { id: true } });
        res = deleteApp(shop, o.h);
        expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
        await tx.appAccess.createMany({ data: apps.map((x) => ({ appId: x.id, userId: a.id, role: 'MEMBER' as const })) });
      });
      expect((await res!).statusCode).toBe(204);
      expect(await app.prisma.appAccess.findMany({ where: { userId: a.id }, select: { appId: true } })).toEqual([{ appId: other }]);
    });

    it('an accept behind a delete waits, then ends cleanly as 410 (its invite went with the app)', async () => {
      const { orgId, shop } = await org();
      const inv = await invite(orgId, shop, 'n@x.io', 'MEMBER');
      const n = await user('n@x.io');
      let res: Promise<Res> | undefined;
      await app.prisma.$transaction(async (tx) => {
        await lockOrg(tx, orgId);
        await tx.app.delete({ where: { id: shop } });
        res = accept(inv.token, n.h);
        expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      });
      const done = await res!;
      expect(done.statusCode).toBe(410);
      expect(done.json()).toEqual({ error: 'invite no longer valid' });
      expect(await app.prisma.membership.count({ where: { orgId, userId: n.id } })).toBe(0);
    });

    it('a demotion behind a delete waits, then grants only the apps that remain', async () => {
      const { o, orgId, shop, other } = await org();
      const a = await member(orgId, 'ADMIN', 'a@x.io');
      let res: Promise<Res> | undefined;
      await app.prisma.$transaction(async (tx) => {
        await lockOrg(tx, orgId);
        await tx.app.delete({ where: { id: shop } });
        res = patchRole(orgId, a.membershipId, 'MEMBER', o.h);
        expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      });
      expect((await res!).statusCode).toBe(200);
      expect(await app.prisma.appAccess.findMany({ where: { userId: a.id }, select: { appId: true } })).toEqual([{ appId: other }]);
    });

    it('a delete and an accept sent together both end cleanly', async () => {
      const { o, orgId, shop } = await org();
      const inv = await invite(orgId, shop, 'n@x.io', 'MEMBER');
      const n = await user('n@x.io');
      const [del, acc] = await Promise.all([deleteApp(shop, o.h), accept(inv.token, n.h)]);
      expect(del.statusCode).toBe(204);
      expect([200, 410]).toContain(acc.statusCode);
      expect(await app.prisma.appAccess.count({ where: { userId: n.id } })).toBe(0);
    });
  });
});
