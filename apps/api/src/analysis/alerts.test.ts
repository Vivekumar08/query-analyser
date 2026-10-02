import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
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
    data: { signatureId: sig.id, suggestion: { status: 1 }, rationale: 'because' },
  });
  return { owner, orgId: org.id, appId: appRow.id, alertId: alert.id, adviceId: advice.id };
}

beforeEach(async () => {
  app = await buildApp();
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
