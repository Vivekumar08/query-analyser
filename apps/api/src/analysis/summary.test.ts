import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
const as = (t: string) => ({ authorization: `Bearer ${t}` });
const hoursAgo = (h: number) => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - h * 3_600_000);
const FINE_100 = [0, 0, 0, 0, 90, 0, 7, 3, 0, 0, 0, 0, 0, 0]; // sums to 100

async function signup(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'Reader' },
  });
  await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  return res.json().accessToken as string;
}

async function seedApp() {
  const token = await signup(`sum-${Date.now()}-${Math.random().toString(36).slice(2)}@x.io`);
  const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(token), payload: { name: 'S' } })).json();
  const appRow = (
    await app.inject({
      method: 'POST',
      url: `/v1/orgs/${org.id}/apps`,
      headers: as(token),
      payload: { name: 's', env: 'production' },
    })
  ).json();
  return { token, appId: appRow.id as string };
}

async function sig(appId: string, source: string | null, orm: string | null = null) {
  return app.prisma.querySignature.create({
    data: {
      appId,
      hash: `h-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      signature: 'x',
      model: 'm',
      operation: 'find',
      filterShape: [],
      sortKeys: [],
      stages: [],
      source,
      orm,
    },
  });
}

async function seedBoth() {
  const s = await seedApp();
  const pg = await sig(s.appId, 'postgresql', 'prisma');
  const mg = await sig(s.appId, null);
  await app.prisma.queryRollup.create({
    data: {
      signatureId: pg.id,
      bucketHour: hoursAgo(2),
      count: 100,
      totalMs: 900n,
      maxMs: 300,
      hist: [0, 0, 0, 3, 0, 0, 0, 0],
      histFine: FINE_100,
      errors: 2,
    },
  });
  await app.prisma.queryRollup.create({
    data: { signatureId: mg.id, bucketHour: hoursAgo(2), count: 7, totalMs: 1400n, maxMs: 400, hist: [0, 0, 7, 0, 0, 0, 0, 0] },
  });
  return { ...s, pg, mg };
}

const get = (s: { token: string; appId: string }, qs = '') =>
  app.inject({ method: 'GET', url: `/v1/apps/${s.appId}/summary${qs}`, headers: as(s.token) });

beforeEach(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app?.close();
});

describe('GET /v1/apps/:id/summary', () => {
  it('returns separate figures per source and no combined total', async () => {
    const s = await seedBoth();
    const res = await get(s);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.grain).toBe('hourly');
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0]).toMatchObject({ source: 'postgresql', counts: 'all-statements', count: 100, slowCount: 3, errors: 2, totalMs: '900', maxMs: 300, avgMs: 9 });
    expect(body.sources[0].p50.basis).toBe('interpolated');
    expect(body.sources[1]).toMatchObject({ source: 'mongodb', counts: 'slow-only', count: 7, slowCount: 7, totalMs: '1400' });
    expect(body.sources[1].p95).not.toBeNull();
    expect(Object.keys(body)).not.toContain('count');
    expect(Object.keys(body)).not.toContain('total');
    expect(Object.keys(body).sort()).toEqual(['droppedNew', 'from', 'grain', 'sources', 'thresholdMs', 'to']);
  });

  it('gives SQL null percentiles when the fine histogram is incomplete', async () => {
    const s = await seedApp();
    const pg = await sig(s.appId, 'postgresql');
    await app.prisma.queryRollup.create({
      data: { signatureId: pg.id, bucketHour: hoursAgo(2), count: 50, totalMs: 10n, maxMs: 5, hist: [0, 0, 0, 0, 0, 0, 0, 0], histFine: FINE_100.map((n) => n / 2) },
    });
    await app.prisma.queryRollup.create({
      data: { signatureId: pg.id, bucketHour: hoursAgo(3), count: 40, totalMs: 10n, maxMs: 5, hist: [0, 0, 0, 0, 0, 0, 0, 0] },
    });
    const src = (await get(s)).json().sources[0];
    expect(src).toMatchObject({ count: 90, p50: null, p95: null, p99: null });
  });

  it('marks a source sampled when any rollup in the window has a rate below 1', async () => {
    const s = await seedBoth();
    await app.prisma.queryRollup.update({
      where: { signatureId_bucketHour: { signatureId: s.pg.id, bucketHour: hoursAgo(2) } },
      data: { minSampleRate: 0.1 },
    });
    const [pg, mg] = (await get(s)).json().sources;
    expect(pg).toMatchObject({ sampled: true, sampleRate: 0.1 });
    expect(mg).toMatchObject({ sampled: false, sampleRate: null });
  });

  it('returns the quota drops in the window and the app threshold', async () => {
    const s = await seedBoth();
    await app.prisma.app.update({ where: { id: s.appId }, data: { thresholdMs: 100 } });
    await app.prisma.quotaDrop.createMany({
      data: [
        { appId: s.appId, bucketHour: hoursAgo(1), droppedNew: 4 },
        { appId: s.appId, bucketHour: hoursAgo(5), droppedNew: 6 },
        { appId: s.appId, bucketHour: hoursAgo(30), droppedNew: 100 },
      ],
    });
    const body = (await get(s)).json();
    expect(body.droppedNew).toBe(10);
    expect(body.thresholdMs).toBe(100);
  });

  it('scopes to the caller app', async () => {
    const s = await seedBoth();
    const other = await seedApp();
    const res = await get(other);
    expect(res.json()).toMatchObject({ sources: [], droppedNew: 0, thresholdMs: null });
    expect((await get(s)).json().sources).toHaveLength(2);
  });

  it('filters by source and orm', async () => {
    const s = await seedBoth();
    const bySource = (await get(s, '?source=mongodb')).json();
    expect(bySource.sources.map((x: { source: string }) => x.source)).toEqual(['mongodb']);
    const byOrm = (await get(s, '?orm=prisma')).json();
    expect(byOrm.sources.map((x: { source: string }) => x.source)).toEqual(['postgresql']);
    expect((await get(s, '?source=a&source=b')).statusCode).toBe(400);
  });

  it('reads daily rollups for a window longer than seven days', async () => {
    const s = await seedApp();
    const pg = await sig(s.appId, 'postgresql');
    const day = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 10));
    await app.prisma.queryDailyRollup.create({
      data: { signatureId: pg.id, day, count: 100, totalMs: 500n, maxMs: 90, hist: [0, 0, 0, 0, 0, 0, 0, 0], histFine: FINE_100, errors: 1 },
    });
    const from = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const body = (await get(s, `?from=${from}`)).json();
    expect(body.grain).toBe('daily');
    expect(body.sources[0]).toMatchObject({ source: 'postgresql', count: 100, slowCount: 0, errors: 1 });
  });

  it('orders postgresql, then mongodb, then others alphabetically', async () => {
    const s = await seedBoth();
    for (const src of ['zeta', 'alpha']) {
      const x = await sig(s.appId, src);
      await app.prisma.queryRollup.create({
        data: { signatureId: x.id, bucketHour: hoursAgo(2), count: 1, totalMs: 1n, maxMs: 1, hist: [0, 0, 0, 0, 0, 0, 0, 0] },
      });
    }
    const names = (await get(s)).json().sources.map((x: { source: string }) => x.source);
    expect(names).toEqual(['postgresql', 'mongodb', 'alpha', 'zeta']);
  });

  it('404s a non-member (no existence leak) and 400s an inverted window', async () => {
    const s = await seedBoth();
    const stranger = await signup(`str-${Date.now()}@x.io`);
    const denied = await app.inject({ method: 'GET', url: `/v1/apps/${s.appId}/summary`, headers: as(stranger) });
    expect(denied.statusCode).toBe(404);
    const bad = await get(s, `?from=${new Date().toISOString()}&to=${new Date(Date.now() - 86_400_000).toISOString()}`);
    expect(bad.statusCode).toBe(400);
  });
});
