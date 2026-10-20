import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { hashKey } from '../ingest/keys.js';
import { settledOrBlocked } from '../test/locks.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

// Signup is rate-limited per IP; give each fixture signup its own address.
let nextIp = 1;
const signupIp = () => `10.2.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;

async function owner() {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', remoteAddress: signupIp(), payload: { email: 'o@x.io', password: 'correct horse battery', name: 'O' } });
  await app.prisma.user.update({ where: { email: 'o@x.io' }, data: { emailVerifiedAt: new Date() } });
  const token = s.json().accessToken as string;
  const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Acme' } })).json();
  return { token, orgId: org.id as string, h: { authorization: `Bearer ${token}` } };
}

describe('apps', () => {
  it('creates and lists apps in an org', async () => {
    const o = await owner();
    const c = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } });
    expect(c.statusCode).toBe(201);
    const l = await app.inject({ method: 'GET', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h });
    expect(l.json()).toEqual([expect.objectContaining({ name: 'web', env: 'production' })]);
  });

  it('409s a duplicate (name, env)', async () => {
    const o = await owner();
    await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } });
    expect((await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).statusCode).toBe(409);
  });

  it('GET /v1/apps/:id reports ingest health', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const g = await app.inject({ method: 'GET', url: `/v1/apps/${a.id}`, headers: o.h });
    expect(g.statusCode).toBe(200);
    expect(g.json()).toMatchObject({ id: a.id, ingest: { lastSeenAt: null, keyCount: 0 } });
  });

  it('404s an app in an org the caller is not part of', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'x@x.io', password: 'correct horse battery', name: 'X' } });
    await app.prisma.user.update({ where: { email: 'x@x.io' }, data: { emailVerifiedAt: new Date() } });
    const res = await app.inject({ method: 'GET', url: `/v1/apps/${a.id}`, headers: { authorization: `Bearer ${s.json().accessToken}` } });
    expect(res.statusCode).toBe(404);
  });

  it('gives identical 404 bodies for a foreign app and a nonexistent app (no enumeration oracle)', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'x2@x.io', password: 'correct horse battery', name: 'X2' } });
    await app.prisma.user.update({ where: { email: 'x2@x.io' }, data: { emailVerifiedAt: new Date() } });
    const h = { authorization: `Bearer ${s.json().accessToken}` };
    const foreign = await app.inject({ method: 'GET', url: `/v1/apps/${a.id}`, headers: h });
    const nonexistent = await app.inject({ method: 'GET', url: '/v1/apps/00000000-0000-0000-0000-000000000000', headers: h });
    expect(foreign.statusCode).toBe(nonexistent.statusCode);
    expect(foreign.json()).toEqual(nonexistent.json());
  });

  it('409s a duplicate (name, env) raced through concurrent creates', async () => {
    const o = await owner();
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'race', env: 'production' } }),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('403s a VIEWER attempting to create an app', async () => {
    const o = await owner();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'v@x.io', password: 'correct horse battery', name: 'V' } });
    await app.prisma.user.update({ where: { email: 'v@x.io' }, data: { emailVerifiedAt: new Date() } });
    await app.prisma.membership.create({ data: { userId: s.json().user.id, orgId: o.orgId, role: 'VIEWER' } });
    const h = { authorization: `Bearer ${s.json().accessToken}` };
    const res = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: h, payload: { name: 'web', env: 'production' } });
    expect(res.statusCode).toBe(403);
  });

  it('403s a MEMBER attempting to create an app', async () => {
    const o = await owner();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'm@x.io', password: 'correct horse battery', name: 'M' } });
    await app.prisma.user.update({ where: { email: 'm@x.io' }, data: { emailVerifiedAt: new Date() } });
    await app.prisma.membership.create({ data: { userId: s.json().user.id, orgId: o.orgId, role: 'MEMBER' } });
    const h = { authorization: `Bearer ${s.json().accessToken}` };
    const res = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: h, payload: { name: 'web', env: 'production' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'insufficient role' });
  });

  it('lets an ADMIN create an app', async () => {
    const o = await owner();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'adm@x.io', password: 'correct horse battery', name: 'A' } });
    await app.prisma.user.update({ where: { email: 'adm@x.io' }, data: { emailVerifiedAt: new Date() } });
    await app.prisma.membership.create({ data: { userId: s.json().user.id, orgId: o.orgId, role: 'ADMIN' } });
    const h = { authorization: `Bearer ${s.json().accessToken}` };
    const res = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: h, payload: { name: 'web', env: 'production' } });
    expect(res.statusCode).toBe(201);
  });

  it('a free org cannot create a second app', async () => {
    const o = await owner();
    expect((await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).statusCode).toBe(201);
    const res = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'api', env: 'production' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'plan-limit', limit: 'apps', max: 1 });
  });

  it('two concurrent creates of different apps on free make exactly one app', async () => {
    const o = await owner();
    const results = await Promise.all(['a', 'b'].map((name) =>
      app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name, env: 'production' } })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403]);
    expect(await app.prisma.app.count({ where: { orgId: o.orgId } })).toBe(1);
  });

  it('a create waits on the org-row lock, then sees the app created meanwhile', async () => {
    // In-process Promise.all serialises, so pin the lock: this transaction
    // plays a concurrent create of a different app, holding the org row.
    const o = await owner();
    let res: Promise<{ statusCode: number; json: () => unknown }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${o.orgId} FOR UPDATE`;
      res = app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'b', env: 'production' } });
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await tx.app.create({ data: { orgId: o.orgId, name: 'a', env: 'production' } });
    });
    const done = await res!;
    expect(done.statusCode).toBe(403);
    expect(done.json()).toEqual({ error: 'plan-limit', limit: 'apps', max: 1 });
    expect(await app.prisma.app.count({ where: { orgId: o.orgId } })).toBe(1);
  });

  it('an org already over its limit keeps its apps but cannot add one', async () => {
    const o = await owner();
    await app.prisma.app.create({ data: { orgId: o.orgId, name: 'one', env: 'production' } });
    await app.prisma.app.create({ data: { orgId: o.orgId, name: 'two', env: 'production' } });
    const res = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'three', env: 'production' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'plan-limit', limit: 'apps', max: 1 });
    expect(await app.prisma.app.count({ where: { orgId: o.orgId } })).toBe(2);
  });

  it('a team org can create up to 10', async () => {
    const o = await owner();
    await app.prisma.organization.update({ where: { id: o.orgId }, data: { plan: 'team' } });
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: `app${i}`, env: 'production' } });
      expect(r.statusCode).toBe(201);
    }
    const res = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'app10', env: 'production' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'plan-limit', limit: 'apps', max: 10 });
  });
});

describe('keys', () => {
  it('creates a key, returns it exactly once, stores only its hash and prefix', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const c = await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: o.h });
    expect(c.statusCode).toBe(201);
    const { key, prefix, id } = c.json();
    expect(key).toMatch(/^qa_live_[0-9a-f]{32}$/);
    expect(prefix).toBe(key.slice(0, 12));

    const row = await app.prisma.ingestKey.findUniqueOrThrow({ where: { id } });
    expect(row.keyHash).toBe(hashKey(key));
    expect(JSON.stringify(row)).not.toContain(key);

    const l = await app.inject({ method: 'GET', url: `/v1/apps/${a.id}/keys`, headers: o.h });
    expect(l.json()).toEqual([expect.objectContaining({ id, prefix, revokedAt: null })]);
    expect(JSON.stringify(l.json())).not.toContain(key);
  });

  it('revokes a key and the ingest route rejects it immediately', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const { key, id } = (await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: o.h })).json();
    const body = { app: 'web', env: 'production', host: 'h', sdkVersion: '0.1.0', bucket: '2026092014', thresholdMs: 100, dropped: 0, items: [] };
    expect((await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: body })).statusCode).toBe(202);
    expect((await app.inject({ method: 'DELETE', url: `/v1/apps/${a.id}/keys/${id}`, headers: o.h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: body })).statusCode).toBe(401);
  });

  it('MEMBER cannot manage keys', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const { id: keyId } = (await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: o.h })).json();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'm@x.io', password: 'correct horse battery', name: 'M' } });
    await app.prisma.user.update({ where: { email: 'm@x.io' }, data: { emailVerifiedAt: new Date() } });
    await app.prisma.membership.create({ data: { userId: s.json().user.id, orgId: o.orgId, role: 'MEMBER' } });
    await app.prisma.appAccess.create({ data: { appId: a.id, userId: s.json().user.id, role: 'MEMBER' } });
    const h = { authorization: `Bearer ${s.json().accessToken}` };
    expect((await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${a.id}/keys`, headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/v1/apps/${a.id}/keys/${keyId}`, headers: h })).statusCode).toBe(403);
  });

  it('403s minting a key in a suspended org', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    await app.prisma.organization.update({ where: { id: o.orgId }, data: { suspendedAt: new Date() } });
    const res = await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: o.h });
    expect(res.statusCode).toBe(403);
  });

  it('404s re-revoking an already-revoked key and preserves the original revokedAt', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const { id } = (await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: o.h })).json();
    expect((await app.inject({ method: 'DELETE', url: `/v1/apps/${a.id}/keys/${id}`, headers: o.h })).statusCode).toBe(204);
    const firstRevokedAt = (await app.prisma.ingestKey.findUniqueOrThrow({ where: { id } })).revokedAt;
    expect((await app.inject({ method: 'DELETE', url: `/v1/apps/${a.id}/keys/${id}`, headers: o.h })).statusCode).toBe(404);
    const secondRevokedAt = (await app.prisma.ingestKey.findUniqueOrThrow({ where: { id } })).revokedAt;
    expect(secondRevokedAt).toEqual(firstRevokedAt);
  });
});

describe('per-app access', () => {
  const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

  async function memberOf(orgId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER', email: string) {
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', remoteAddress: signupIp(), payload: { email, password: 'correct horse battery', name: email } });
    await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    const id = s.json().user.id as string;
    await app.prisma.membership.create({ data: { userId: id, orgId, role } });
    return { id, h: { authorization: `Bearer ${s.json().accessToken as string}` } };
  }

  async function orgWithTwoApps() {
    const o = await owner();
    await app.prisma.organization.update({ where: { id: o.orgId }, data: { plan: 'team' } });
    const shop = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'shop', env: 'production' } })).json();
    const admin = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'admin', env: 'production' } })).json();
    return { ...o, shop: shop.id as string, admin: admin.id as string };
  }

  const grant = (appId: string, userId: string, role: 'MEMBER' | 'VIEWER') =>
    app.prisma.appAccess.create({ data: { appId, userId, role } });

  it('a MEMBER without a row gets the same 404 as a nonexistent app', async () => {
    const o = await orgWithTwoApps();
    const m = await memberOf(o.orgId, 'MEMBER', 'm@x.io');
    const hidden = await app.inject({ method: 'GET', url: `/v1/apps/${o.shop}`, headers: m.h });
    const nonexistent = await app.inject({ method: 'GET', url: `/v1/apps/${NONEXISTENT}`, headers: m.h });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(nonexistent.statusCode);
    expect(hidden.json()).toEqual(nonexistent.json());
    expect(hidden.json()).toEqual({ error: 'Not Found' });
  });

  it('a MEMBER with a row reads that app only', async () => {
    const o = await orgWithTwoApps();
    const m = await memberOf(o.orgId, 'MEMBER', 'm@x.io');
    await grant(o.shop, m.id, 'MEMBER');
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${o.shop}`, headers: m.h })).statusCode).toBe(200);
    const other = await app.inject({ method: 'GET', url: `/v1/apps/${o.admin}`, headers: m.h });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: 'Not Found' });
    // the analysis routes go through the same gate
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${o.shop}/alerts`, headers: m.h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${o.admin}/alerts`, headers: m.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${o.admin}/queries`, headers: m.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${o.admin}/advice`, headers: m.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${o.admin}/sample-key`, headers: m.h })).statusCode).toBe(404);
  });

  it('a VIEWER without a row gets 404', async () => {
    const o = await orgWithTwoApps();
    const v = await memberOf(o.orgId, 'VIEWER', 'v@x.io');
    await grant(o.shop, v.id, 'VIEWER');
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${o.shop}`, headers: v.h })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: `/v1/apps/${o.admin}`, headers: v.h });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found' });
  });

  it('the row role decides, not the membership role', async () => {
    const o = await orgWithTwoApps();
    const alert = '11111111-1111-1111-1111-111111111111';
    const up = await memberOf(o.orgId, 'VIEWER', 'up@x.io');
    await grant(o.shop, up.id, 'MEMBER');
    const passed = await app.inject({ method: 'PATCH', url: `/v1/apps/${o.shop}/alerts/${alert}`, headers: up.h, payload: { status: 'ACKNOWLEDGED' } });
    expect(passed.statusCode).toBe(404);
    expect(passed.json()).toEqual({ error: 'Not Found' });

    const down = await memberOf(o.orgId, 'MEMBER', 'down@x.io');
    await grant(o.shop, down.id, 'VIEWER');
    const refused = await app.inject({ method: 'PATCH', url: `/v1/apps/${o.shop}/alerts/${alert}`, headers: down.h, payload: { status: 'ACKNOWLEDGED' } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'insufficient role' });
  });

  it('OWNER and ADMIN need no row', async () => {
    const o = await orgWithTwoApps();
    const a = await memberOf(o.orgId, 'ADMIN', 'a@x.io');
    for (const h of [o.h, a.h]) {
      for (const id of [o.shop, o.admin]) {
        expect((await app.inject({ method: 'GET', url: `/v1/apps/${id}`, headers: h })).statusCode).toBe(200);
      }
    }
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${o.admin}/keys`, headers: a.h })).statusCode).toBe(200);
  });

  it('lists only accessible apps for MEMBER/VIEWER, every app for ADMIN', async () => {
    const o = await orgWithTwoApps();
    const m = await memberOf(o.orgId, 'MEMBER', 'm@x.io');
    await grant(o.shop, m.id, 'MEMBER');
    const none = await memberOf(o.orgId, 'VIEWER', 'none@x.io');
    const a = await memberOf(o.orgId, 'ADMIN', 'a@x.io');
    const names = async (h: Record<string, string>) =>
      ((await app.inject({ method: 'GET', url: `/v1/orgs/${o.orgId}/apps`, headers: h })).json() as { name: string }[]).map((x) => x.name);
    expect(await names(m.h)).toEqual(['shop']);
    expect(await names(none.h)).toEqual([]);
    expect(await names(a.h)).toEqual(['shop', 'admin']);
    expect(await names(o.h)).toEqual(['shop', 'admin']);
  });

  it('a member without access to an app in a suspended org gets 404, not 403 (Review Focus)', async () => {
    const o = await orgWithTwoApps();
    const none = await memberOf(o.orgId, 'MEMBER', 'none@x.io');
    const m = await memberOf(o.orgId, 'MEMBER', 'm@x.io');
    await grant(o.shop, m.id, 'MEMBER');
    await app.prisma.organization.update({ where: { id: o.orgId }, data: { suspendedAt: new Date() } });
    const hidden = await app.inject({ method: 'GET', url: `/v1/apps/${o.shop}`, headers: none.h });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'Not Found' });
    const nonexistent = await app.inject({ method: 'GET', url: `/v1/apps/${NONEXISTENT}`, headers: none.h });
    expect(hidden.json()).toEqual(nonexistent.json());
    const suspended = await app.inject({ method: 'GET', url: `/v1/apps/${o.shop}`, headers: m.h });
    expect(suspended.statusCode).toBe(403);
    expect(suspended.json()).toEqual({ error: 'organization suspended' });
  });
});
