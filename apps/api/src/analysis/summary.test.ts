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

  it('aggregates one source across signatures and hours, excluding rows outside the window', async () => {
    const s = await seedApp();
    const a = await sig(s.appId, 'postgresql');
    const b = await sig(s.appId, 'postgresql');
    const z = [0, 0, 0, 0, 0, 0, 0, 0];
    const fine = (m: Record<number, number>) => Array.from({ length: 14 }, (_, i) => m[i] ?? 0);
    const rows = [
      { signatureId: a.id, bucketHour: hoursAgo(2), count: 50, totalMs: 400n, maxMs: 240, errors: 1, hist: [0, 0, 0, 2, 0, 0, 0, 0], histFine: fine({ 4: 40, 7: 10 }) },
      { signatureId: a.id, bucketHour: hoursAgo(3), count: 30, totalMs: 300n, maxMs: 50, errors: 2, hist: [0, 0, 0, 1, 1, 0, 0, 0], histFine: fine({ 4: 20, 6: 10 }), minSampleRate: 0.5 },
      { signatureId: b.id, bucketHour: hoursAgo(2), count: 20, totalMs: 200n, maxMs: 30, errors: 0, hist: [0, 0, 0, 0, 0, 1, 0, 0], histFine: fine({ 4: 10, 5: 10 }), minSampleRate: 0.1 },
      { signatureId: b.id, bucketHour: hoursAgo(4), count: 20, totalMs: 100n, maxMs: 15, errors: 3, hist: z, histFine: fine({ 3: 20 }) },
      // 30 hours ago: outside the default 24h window
      { signatureId: b.id, bucketHour: hoursAgo(30), count: 999, totalMs: 99999n, maxMs: 9999, errors: 99, hist: z, histFine: fine({ 0: 999 }), minSampleRate: 0.01 },
    ];
    for (const data of rows) await app.prisma.queryRollup.create({ data });
    const body = (await get(s)).json();
    expect(body.sources).toHaveLength(1);
    // Fine bounds [1,2,5,10,25,50,100,250,...]: summed buckets 3:20 4:70 5:10 6:10 7:10 (120).
    // p50: target 60 in (10,25]: 10 + 15*(60-20)/70 = 18.57
    // p95: target 114 in (100,250]: 100 + 150*(114-110)/10 = 160
    // p99: target 118.8 in (100,250]: 100 + 150*(118.8-110)/10 = 232 (below maxMs 240)
    expect(body.sources[0]).toMatchObject({
      source: 'postgresql',
      count: 120,
      totalMs: '1000',
      avgMs: 8.33,
      maxMs: 240,
      errors: 6,
      slowCount: 5,
      sampled: true,
      sampleRate: 0.1,
      p50: { value: 18.57, basis: 'interpolated' },
      p95: { value: 160, basis: 'interpolated' },
      p99: { value: 232, basis: 'interpolated' },
    });
  });

  it('aggregates the daily grain with percentiles and sampling', async () => {
    const s = await seedApp();
    const a = await sig(s.appId, 'postgresql');
    const midnight = (d: number) => {
      const n = new Date();
      return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - d));
    };
    const z = [0, 0, 0, 0, 0, 0, 0, 0];
    await app.prisma.queryDailyRollup.create({
      data: { signatureId: a.id, day: midnight(10), count: 100, totalMs: 500n, maxMs: 90, hist: z, histFine: FINE_100, errors: 1, minSampleRate: 0.25 },
    });
    await app.prisma.queryDailyRollup.create({
      data: { signatureId: a.id, day: midnight(11), count: 50, totalMs: 250n, maxMs: 40, hist: z, histFine: [0, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0], errors: 2 },
    });
    const from = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const body = (await get(s, `?from=${from}`)).json();
    expect(body.grain).toBe('daily');
    // fine sum: bucket4 140, bucket6 7, bucket7 3 (150). p50: target 75 -> 10 + 15*75/140 = 18.04
    // p95: target 142.5 in (50,100]: 50 + 50*(142.5-140)/7 = 67.86
    expect(body.sources[0]).toMatchObject({
      count: 150,
      totalMs: '750',
      avgMs: 5,
      maxMs: 90,
      errors: 3,
      sampled: true,
      sampleRate: 0.25,
      p50: { value: 18.04, basis: 'interpolated' },
      p95: { value: 67.86, basis: 'interpolated' },
    });
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
