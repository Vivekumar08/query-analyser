import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { queryHourlyRanking } from './routes.js';
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

/**
 * Adds a second (or third...) signature + single rollup to an app already
 * created by `seed()`, for tests that need more than one signature to
 * observe filtering or ordering.
 */
async function addSignature(
  appId: string,
  overrides: { hash: string; model?: string; operation?: string },
  rollup: { count: number; totalMs: bigint; maxMs: number; hist: number[] },
) {
  const sig = await app.prisma.querySignature.create({
    data: {
      appId,
      hash: overrides.hash,
      signature: `${overrides.model ?? 'users'}.${overrides.operation ?? 'find'}({})`,
      model: overrides.model ?? 'users',
      operation: overrides.operation ?? 'find',
      filterShape: [],
      sortKeys: [],
      stages: [],
    },
  });
  await app.prisma.queryRollup.create({
    data: { signatureId: sig.id, bucketHour: new Date(Date.now() - 3_600_000), ...rollup },
  });
  return sig;
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

  it('ranking SQL casts totalMs to a true bigint, not a Decimal', async () => {
    const { appId } = await seed();
    const rows = await queryHourlyRanking(app.prisma, {
      appId,
      from: new Date(Date.now() - 86_400_000),
      to: new Date(),
      model: null,
      op: null,
      limit: 50,
    });
    expect(rows.length).toBeGreaterThan(0);
    // The whole point: assert the raw query-result type, not the
    // serialized JSON string, which looks identical ('1000') whether it
    // came from a real BigInt via the reply serializer or from decimal.js's
    // toJSON on an unconverted Decimal.
    expect(typeof rows[0]!.totalMs).toBe('bigint');
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

  it.each([
    ['detail', (appId: string, hash: string) => `/v1/apps/${appId}/queries/${hash}`],
    ['series', (appId: string, hash: string) => `/v1/apps/${appId}/queries/${hash}/series`],
  ])('404s a signature belonging to another app on the %s route', async (_label, urlFor) => {
    const { token, appId } = await seed();
    const other = await seed();
    const res = await app.inject({
      method: 'GET',
      url: urlFor(appId, other.sigHash),
      headers: as(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s a malformed from', async () => {
    const { token, appId } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?from=yesterday`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a repeated query param instead of 500ing on an array bound', async () => {
    const { token, appId } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?model=a&model=b`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('filters by model', async () => {
    const { token, appId, sigHash } = await seed(); // seed()'s signature has model 'users'
    await addSignature(
      appId,
      { hash: 'other-model', model: 'orders' },
      { count: 50, totalMs: 9000n, maxMs: 500, hist: [0, 0, 0, 50, 0, 0, 0, 0] },
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?model=users`,
      headers: as(token),
    });
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].hash).toBe(sigHash);
  });

  it('filters by operation', async () => {
    const { token, appId, sigHash } = await seed(); // seed()'s signature has operation 'find'
    await addSignature(
      appId,
      { hash: 'other-op', operation: 'aggregate' },
      { count: 50, totalMs: 9000n, maxMs: 500, hist: [0, 0, 0, 50, 0, 0, 0, 0] },
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?op=find`,
      headers: as(token),
    });
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].hash).toBe(sigHash);
  });

  it('supports sort=count, which orders differently from the wasted-time default', async () => {
    const { token, appId } = await seed();
    const highCountLowWaste = await addSignature(
      appId,
      { hash: 'high-count' },
      { count: 100, totalMs: 1000n, maxMs: 50, hist: [100, 0, 0, 0, 0, 0, 0, 0] },
    );
    const lowCountHighWaste = await addSignature(
      appId,
      { hash: 'high-waste' },
      { count: 5, totalMs: 5000n, maxMs: 900, hist: [0, 0, 0, 0, 0, 5, 0, 0] },
    );

    const byWaste = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries`,
      headers: as(token),
    });
    const byCount = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?sort=count`,
      headers: as(token),
    });

    const rankOf = (hashes: string[], hash: string) => hashes.indexOf(hash);
    const wasteHashes = byWaste.json().items.map((i: { hash: string }) => i.hash);
    const countHashes = byCount.json().items.map((i: { hash: string }) => i.hash);

    expect(rankOf(wasteHashes, lowCountHighWaste.hash)).toBeLessThan(rankOf(wasteHashes, highCountLowWaste.hash));
    expect(rankOf(countHashes, highCountLowWaste.hash)).toBeLessThan(rankOf(countHashes, lowCountHighWaste.hash));
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
