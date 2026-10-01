import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { hashKey } from '../ingest/keys.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function owner() {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'o@x.io', password: 'correct horse battery', name: 'O' } });
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
    const res = await app.inject({ method: 'GET', url: `/v1/apps/${a.id}`, headers: { authorization: `Bearer ${s.json().accessToken}` } });
    expect(res.statusCode).toBe(404);
  });

  it('gives identical 404 bodies for a foreign app and a nonexistent app (no enumeration oracle)', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'x2@x.io', password: 'correct horse battery', name: 'X2' } });
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
    await app.prisma.membership.create({ data: { userId: s.json().user.id, orgId: o.orgId, role: 'VIEWER' } });
    const h = { authorization: `Bearer ${s.json().accessToken}` };
    const res = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: h, payload: { name: 'web', env: 'production' } });
    expect(res.statusCode).toBe(403);
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
    await app.prisma.membership.create({ data: { userId: s.json().user.id, orgId: o.orgId, role: 'MEMBER' } });
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
