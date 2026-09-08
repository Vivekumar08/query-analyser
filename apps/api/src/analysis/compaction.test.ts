import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { compactDay, pruneHourly, pruneDaily } from './compaction.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let appId: string;
let signatureId: string;

async function seedSignature() {
  const org = await app.prisma.organization.create({
    data: { name: 'Compact Co', slug: `compact-${Date.now()}` },
  });
  const a = await app.prisma.app.create({
    data: { orgId: org.id, name: 'compact', env: 'production' },
  });
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: a.id,
      hash: `h${Date.now()}`.slice(0, 16).padEnd(16, '0'),
      signature: 'users.find({email})',
      model: 'users',
      operation: 'find',
      filterShape: [{ key: 'email', op: 'eq' }],
      sortKeys: [],
      stages: [],
    },
  });
  return { appId: a.id, signatureId: sig.id };
}

beforeEach(async () => {
  app = await buildApp();
  const seeded = await seedSignature();
  appId = seeded.appId;
  signatureId = seeded.signatureId;
});

afterAll(async () => {
  await app?.close();
});

describe('compactDay', () => {
  it('sums hourly rollups into one daily row, adding hist element-wise', async () => {
    await app.prisma.queryRollup.createMany({
      data: [
        {
          signatureId,
          bucketHour: new Date('2026-09-10T01:00:00.000Z'),
          count: 3,
          totalMs: 300n,
          maxMs: 120,
          hist: [1, 2, 0, 0, 0, 0, 0, 0],
        },
        {
          signatureId,
          bucketHour: new Date('2026-09-10T05:00:00.000Z'),
          count: 4,
          totalMs: 800n,
          maxMs: 400,
          hist: [0, 1, 3, 0, 0, 0, 0, 0],
        },
      ],
    });

    const written = await compactDay(app.prisma, new Date('2026-09-10T00:00:00.000Z'));
    expect(written).toBe(1);

    const daily = await app.prisma.queryDailyRollup.findFirstOrThrow({
      where: { signatureId },
    });
    expect(daily.count).toBe(7);
    expect(Number(daily.totalMs)).toBe(1100);
    expect(daily.maxMs).toBe(400);
    expect(daily.hist).toEqual([1, 3, 3, 0, 0, 0, 0, 0]);
  });

  it('is idempotent — running twice does not double the numbers', async () => {
    await app.prisma.queryRollup.create({
      data: {
        signatureId,
        bucketHour: new Date('2026-09-11T02:00:00.000Z'),
        count: 5,
        totalMs: 500n,
        maxMs: 200,
        hist: [5, 0, 0, 0, 0, 0, 0, 0],
      },
    });

    const day = new Date('2026-09-11T00:00:00.000Z');
    await compactDay(app.prisma, day);
    await compactDay(app.prisma, day);

    const daily = await app.prisma.queryDailyRollup.findFirstOrThrow({
      where: { signatureId },
    });
    expect(daily.count).toBe(5);
    expect(Number(daily.totalMs)).toBe(500);
    expect(daily.hist).toEqual([5, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('only compacts the requested day', async () => {
    await app.prisma.queryRollup.createMany({
      data: [
        {
          signatureId,
          bucketHour: new Date('2026-09-12T03:00:00.000Z'),
          count: 1,
          totalMs: 100n,
          maxMs: 100,
          hist: [1, 0, 0, 0, 0, 0, 0, 0],
        },
        {
          signatureId,
          bucketHour: new Date('2026-09-13T03:00:00.000Z'),
          count: 9,
          totalMs: 900n,
          maxMs: 900,
          hist: [0, 0, 0, 9, 0, 0, 0, 0],
        },
      ],
    });

    await compactDay(app.prisma, new Date('2026-09-12T00:00:00.000Z'));

    const rows = await app.prisma.queryDailyRollup.findMany({ where: { signatureId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
  });
});

describe('pruning', () => {
  it('deletes hourly rollups older than the cutoff and leaves newer ones', async () => {
    await app.prisma.queryRollup.createMany({
      data: [
        {
          signatureId,
          bucketHour: new Date('2026-09-01T00:00:00.000Z'),
          count: 1,
          totalMs: 1n,
          maxMs: 1,
          hist: [1, 0, 0, 0, 0, 0, 0, 0],
        },
        {
          signatureId,
          bucketHour: new Date('2026-09-20T00:00:00.000Z'),
          count: 1,
          totalMs: 1n,
          maxMs: 1,
          hist: [1, 0, 0, 0, 0, 0, 0, 0],
        },
      ],
    });

    const deleted = await pruneHourly(app.prisma, new Date('2026-09-10T00:00:00.000Z'));
    expect(deleted).toBe(1);

    const left = await app.prisma.queryRollup.findMany({ where: { signatureId } });
    expect(left).toHaveLength(1);
    expect(left[0]?.bucketHour.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('deletes daily rollups older than the cutoff', async () => {
    await app.prisma.queryDailyRollup.create({
      data: {
        signatureId,
        day: new Date('2026-01-01T00:00:00.000Z'),
        count: 1,
        totalMs: 1n,
        maxMs: 1,
        hist: [1, 0, 0, 0, 0, 0, 0, 0],
      },
    });

    const deleted = await pruneDaily(app.prisma, new Date('2026-06-01T00:00:00.000Z'));
    expect(deleted).toBe(1);
  });
});
