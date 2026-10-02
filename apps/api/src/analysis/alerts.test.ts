import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

async function user(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'A' },
  });
  return { token: res.json().accessToken as string, id: res.json().user.id as string };
}
const as = (t: string) => ({ authorization: `Bearer ${t}` });

async function seed() {
  const owner = await user(`own-${Date.now()}@x.io`);
  const org = (
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner.token), payload: { name: 'A' } })
  ).json();
  const appRow = (
    await app.inject({
      method: 'POST',
      url: `/v1/orgs/${org.id}/apps`,
      headers: as(owner.token),
      payload: { name: 'a', env: 'production' },
    })
  ).json();
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: appRow.id,
      hash: `${Date.now()}`.slice(0, 16).padEnd(16, 'f'),
      signature: 'orders.find({status})',
      model: 'orders',
      operation: 'find',
      filterShape: [{ key: 'status', op: 'eq' }],
      sortKeys: [],
      stages: [],
    },
  });
  const alert = await app.prisma.alert.create({
    data: { signatureId: sig.id, kind: 'regression', details: { latestP95: 300, baselineP95: 100 } },
  });
  const advice = await app.prisma.advice.create({
    data: { signatureId: sig.id, suggestion: [{ field: 'status', dir: 1 }], rationale: 'because' },
  });
  return { owner, orgId: org.id, appId: appRow.id, alertId: alert.id, adviceId: advice.id };
}

beforeEach(async () => {
  app = await buildApp();
  // Without this, 'lists alerts for the app' ran first on a fresh database
  // and saw exactly one alert whether the tenant filter was there or not —
  // so the filter was pinned by nothing. Every list assertion below counts
  // rows, which only means something if the table starts empty.
  await resetDb(app.prisma);
});

afterAll(async () => {
  await app?.close();
});

describe('alerts and advice', () => {
  it('lists alerts for the app', async () => {
    const { owner, appId } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/alerts`,
      headers: as(owner.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].kind).toBe('regression');
  });

  /**
   * Pins `where: { signature: { appId: req.appId } }` on GET /alerts. Delete
   * it and this test sees the other tenant's alert too. The pre-existing
   * single-app list test could not: one seeded alert is one alert either way.
   */
  it('lists only this app\'s alerts, never another tenant\'s', async () => {
    const mine = await seed();
    const theirs = await seed();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${mine.appId}/alerts`,
      headers: as(mine.owner.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].id).toBe(mine.alertId);

    // Symmetrically, from the other side.
    const other = await app.inject({
      method: 'GET',
      url: `/v1/apps/${theirs.appId}/alerts`,
      headers: as(theirs.owner.token),
    });
    expect(other.json().items).toHaveLength(1);
    expect(other.json().items[0].id).toBe(theirs.alertId);
  });

  /**
   * GET /advice had no list test at all, so its tenant filter was pinned by
   * even less than the alerts one.
   */
  it('lists only this app\'s advice, never another tenant\'s', async () => {
    const mine = await seed();
    const theirs = await seed();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${mine.appId}/advice`,
      headers: as(mine.owner.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].id).toBe(mine.adviceId);

    const other = await app.inject({
      method: 'GET',
      url: `/v1/apps/${theirs.appId}/advice`,
      headers: as(theirs.owner.token),
    });
    expect(other.json().items).toHaveLength(1);
    expect(other.json().items[0].id).toBe(theirs.adviceId);
  });

  /**
   * The three /queries routes get this via an `it.each`; /alerts and /advice
   * had neither a non-member 404 nor an anonymous 401.
   */
  it.each([
    ['GET', '/alerts'],
    ['GET', '/advice'],
  ])('404s a non-member and 401s anonymous on %s %s', async (method, path) => {
    const { appId } = await seed();
    const stranger = await user(`stranger-${Date.now()}-${Math.random()}@x.io`);

    const outsider = await app.inject({
      method: method as 'GET',
      url: `/v1/apps/${appId}${path}`,
      headers: as(stranger.token),
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toEqual({ error: 'Not Found' });

    const anon = await app.inject({ method: method as 'GET', url: `/v1/apps/${appId}${path}` });
    expect(anon.statusCode).toBe(401);
  });

  /**
   * Ownership is now part of the UPDATE's own filter, so an id that matches
   * nothing raises Prisma's P2025 instead of being caught by a preceding
   * `findFirst`. That has to come back as a 404, not as the 500 the global
   * error handler would otherwise produce.
   */
  it.each([
    ['alerts', (appId: string, id: string) => `/v1/apps/${appId}/alerts/${id}`, {}],
    ['advice', (appId: string, id: string) => `/v1/apps/${appId}/advice/${id}`, { status: 'APPLIED' }],
  ])('404s rather than 500s an unknown %s id', async (_label, urlFor, payload) => {
    const { owner, appId } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: urlFor(appId, '00000000-0000-4000-8000-000000000000'),
      headers: as(owner.token),
      payload,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found' });
  });

  it('acknowledges an alert', async () => {
    const { owner, appId, alertId } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/alerts/${alertId}`,
      headers: as(owner.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().acknowledgedAt).not.toBeNull();
  });

  it('404s acknowledging an alert belonging to another app', async () => {
    const mine = await seed();
    const theirs = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${mine.appId}/alerts/${theirs.alertId}`,
      headers: as(mine.owner.token),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('sets advice status', async () => {
    const { owner, appId, adviceId } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/advice/${adviceId}`,
      headers: as(owner.token),
      payload: { status: 'APPLIED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPLIED');
  });

  it('rejects an unknown advice status', async () => {
    const { owner, appId, adviceId } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/advice/${adviceId}`,
      headers: as(owner.token),
      payload: { status: 'NONSENSE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s setting advice status for advice belonging to another app', async () => {
    const mine = await seed();
    const theirs = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${mine.appId}/advice/${theirs.adviceId}`,
      headers: as(mine.owner.token),
      payload: { status: 'APPLIED' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s an unknown advice status for a cross-app id before the ownership lookup', async () => {
    const mine = await seed();
    const theirs = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${mine.appId}/advice/${theirs.adviceId}`,
      headers: as(mine.owner.token),
      payload: { status: 'NONSENSE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a VIEWER on both PATCH routes', async () => {
    const { owner, orgId, appId, alertId, adviceId } = await seed();
    const viewer = await user(`view-${Date.now()}@x.io`);
    await app.prisma.membership.create({
      data: { userId: viewer.id, orgId, role: 'VIEWER' },
    });

    const a = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/alerts/${alertId}`,
      headers: as(viewer.token),
      payload: {},
    });
    expect(a.statusCode).toBe(403);

    const b = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/advice/${adviceId}`,
      headers: as(viewer.token),
      payload: { status: 'APPLIED' },
    });
    expect(b.statusCode).toBe(403);

    // and a VIEWER can still read
    const r = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/alerts`,
      headers: as(viewer.token),
    });
    expect(r.statusCode).toBe(200);
    expect(owner.token).not.toBe(viewer.token);
  });
});
