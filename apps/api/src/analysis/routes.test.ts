import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

async function user(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'Reader' },
  });
  return res.json().accessToken as string;
}
const as = (t: string) => ({ authorization: `Bearer ${t}` });

async function seed() {
  const token = await user(`reader-${Date.now()}@x.io`);
  const org = (
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(token), payload: { name: 'R' } })
  ).json();
  const appRow = (
    await app.inject({
      method: 'POST',
      url: `/v1/orgs/${org.id}/apps`,
      headers: as(token),
      payload: { name: 'r', env: 'production' },
    })
  ).json();
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: appRow.id,
      hash: `abcdef0123456789-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      signature: 'users.find({email})',
      model: 'users',
      operation: 'find',
      filterShape: [{ key: 'email', op: 'eq' }],
      sortKeys: [],
      stages: [],
      redactedSample: { ms: 20 },
    },
  });
  await app.prisma.queryRollup.create({
    data: {
      signatureId: sig.id,
      bucketHour: new Date(Date.now() - 3_600_000),
      count: 10,
      totalMs: 1000n,
      maxMs: 300,
      hist: [0, 0, 10, 0, 0, 0, 0, 0],
    },
  });
  return { token, appId: appRow.id, sigHash: sig.hash, sigId: sig.id };
}

beforeEach(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe('read APIs', () => {
  it('ranks queries by wasted time and reports the grain used', async () => {
    const { token, appId } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.grain).toBe('hourly');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].totalMs).toBe('1000'); // BigInt -> string
    expect(body.items[0].avgMs).toBe(100);
    expect(body.items[0].p95.basis).toBe('interpolated');
  });

  it('caps limit at 200', async () => {
    const { token, appId } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?limit=9999`,
      headers: as(token),
    });
    expect(res.json().limit).toBe(200);
  });

  it('reads daily rollups for a window longer than seven days', async () => {
    const { token, appId } = await seed();
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?from=${from}`,
      headers: as(token),
    });
    expect(res.json().grain).toBe('daily');
  });

  it('returns detail with the histogram and the redacted sample', async () => {
    const { token, appId, sigHash } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries/${sigHash}`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().signature).toBe('users.find({email})');
    expect(res.json().hist).toEqual([0, 0, 10, 0, 0, 0, 0, 0]);
    expect(res.json().redactedSample).toEqual({ ms: 20 });
  });

  it('404s a signature belonging to another app', async () => {
    const { token, appId } = await seed();
    const other = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries/${other.sigHash}`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns a series of points', async () => {
    const { token, appId, sigHash } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries/${sigHash}/series`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(1);
    expect(res.json().points[0].count).toBe(10);
  });

  it.each([
    ['GET', '/queries'],
    ['GET', '/queries/abcdef0123456789'],
    ['GET', '/queries/abcdef0123456789/series'],
  ])('404s a non-member and 401s anonymous on %s %s', async (method, path) => {
    const { appId } = await seed();
    const stranger = await user(`stranger-${Date.now()}@x.io`);

    const outsider = await app.inject({
      method: method as 'GET',
      url: `/v1/apps/${appId}${path}`,
      headers: as(stranger),
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toEqual({ error: 'Not Found' });

    const anon = await app.inject({ method: method as 'GET', url: `/v1/apps/${appId}${path}` });
    expect(anon.statusCode).toBe(401);
  });
});
