import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { compactDay, pruneHourly, pruneDailyByPlan } from './compaction.js';
import { runNightlyJobs } from './jobs.js';
import { resetDb } from '../test/db.js';
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

});

describe('pruneDailyByPlan', () => {
  const DAY = 86_400_000;
  const now = new Date('2026-10-20T02:00:00.000Z');
  const midnight = new Date('2026-10-20T00:00:00.000Z');
  const graceOver = new Date('2026-10-01T00:00:00.000Z');
  const graceOn = new Date('2027-01-31T00:00:00.000Z');

  /** An org on `plan` with one signature, and a daily row `ago` UTC midnights before 2026-10-20. */
  async function orgWithDays(plan: string, ago: number[]) {
    const org = await app.prisma.organization.create({ data: { name: plan, slug: `prune-${plan}`, plan } });
    const a = await app.prisma.app.create({ data: { orgId: org.id, name: plan, env: 'production' } });
    const sig = await app.prisma.querySignature.create({
      data: {
        appId: a.id, hash: plan.padEnd(16, '0').slice(0, 16), signature: 's', model: 'm', operation: 'find',
        filterShape: [], sortKeys: [], stages: [],
      },
    });
    await app.prisma.queryDailyRollup.createMany({
      data: ago.map((n) => ({
        signatureId: sig.id, day: new Date(midnight.getTime() - n * DAY),
        count: 1, totalMs: 1n, maxMs: 1, hist: [1, 0, 0, 0, 0, 0, 0, 0],
      })),
    });
    return sig.id;
  }

  /** Which of the seeded days are still there, as days-ago numbers, newest first. */
  async function keptDays(signatureId: string) {
    const rows = await app.prisma.queryDailyRollup.findMany({ where: { signatureId }, orderBy: { day: 'desc' } });
    return rows.map((r) => Math.round((midnight.getTime() - r.day.getTime()) / DAY));
  }

  const AGES = [29, 31, 89, 91, 364, 366];

  beforeEach(async () => { await resetDb(app.prisma); });

  it('after the grace, each org keeps its own plan\'s days (unknown plans keep free\'s)', async () => {
    const free = await orgWithDays('free', AGES);
    const pro = await orgWithDays('pro', AGES);
    const team = await orgWithDays('team', AGES);
    const unknown = await orgWithDays('legacy-unknown', AGES);

    const deleted = await pruneDailyByPlan(app.prisma, now, graceOver);

    expect(deleted).toBe(5 + 3 + 1 + 5);
    expect(await keptDays(free)).toEqual([29]);
    expect(await keptDays(pro)).toEqual([29, 31, 89]);
    expect(await keptDays(team)).toEqual([29, 31, 89, 91, 364]);
    expect(await keptDays(unknown)).toEqual([29]);
  });

  it('inside the grace, every org keeps at least 90 days and team keeps 365', async () => {
    const free = await orgWithDays('free', AGES);
    const pro = await orgWithDays('pro', AGES);
    const team = await orgWithDays('team', AGES);
    const unknown = await orgWithDays('legacy-unknown', AGES);

    const deleted = await pruneDailyByPlan(app.prisma, now, graceOn);

    expect(deleted).toBe(3 + 3 + 1 + 3);
    expect(await keptDays(free)).toEqual([29, 31, 89]);
    expect(await keptDays(pro)).toEqual([29, 31, 89]);
    expect(await keptDays(team)).toEqual([29, 31, 89, 91, 364]);
    expect(await keptDays(unknown)).toEqual([29, 31, 89]);
  });

  it('keeps a row exactly at the cutoff and deletes the day before it', async () => {
    const free = await orgWithDays('free', [30, 31]);
    const team = await orgWithDays('team', [365, 366]);
    expect(await pruneDailyByPlan(app.prisma, midnight, graceOver)).toBe(2);
    expect(await keptDays(free)).toEqual([30]);
    expect(await keptDays(team)).toEqual([365]);

    await resetDb(app.prisma);
    const graced = await orgWithDays('free', [90, 91]);
    expect(await pruneDailyByPlan(app.prisma, midnight, graceOn)).toBe(1);
    expect(await keptDays(graced)).toEqual([90]);
  });

  it('does nothing when no org has data past its retention', async () => {
    await orgWithDays('free', [0, 29]);
    expect(await pruneDailyByPlan(app.prisma, now, graceOver)).toBe(0);
  });
});

/**
 * This file deliberately does NOT mock `./compaction.js` (jobs.test.ts does),
 * so `runNightlyJobs` here drives the real compaction and the real pruning —
 * which is the only way to see the interaction between the two.
 */
describe('nightly retention does not destroy a compacted day', () => {
  const DAY = '2026-09-10';
  const midnight = new Date(`${DAY}T00:00:00.000Z`);

  /** 24 hourly rows for `DAY`, 10 queries an hour at 100ms each. */
  async function seedFullDay(sigId: string) {
    await app.prisma.queryRollup.createMany({
      data: Array.from({ length: 24 }, (_, h) => ({
        signatureId: sigId,
        bucketHour: new Date(Date.UTC(2026, 8, 10, h)),
        count: 10,
        totalMs: 1000n,
        maxMs: 400,
        hist: [0, 0, 10, 0, 0, 0, 0, 0],
      })),
    });
  }

  const dailyRow = (sigId: string) =>
    app.prisma.queryDailyRollup.findUniqueOrThrow({
      where: { signatureId_day: { signatureId: sigId, day: midnight } },
    });

  /**
   * `pruneHourly` must only ever delete WHOLE UTC days. Given an instant
   * (`now - 7 days`) instead of a day boundary, the oldest retained day is
   * half-deleted: the hours before the tick's time-of-day go, the rest stay.
   * The next night the compaction loop picks the oldest *surviving* hourly
   * row, rounds it down to UTC midnight — still inside that same, now
   * fragmentary day — and compacts it again; `compactDay` replaces rather
   * than accumulates, so it overwrites a correct daily row with a
   * recomputation from the fragment. The night after, the rest of the day is
   * pruned, so the day is never revisited and the undercount is permanent for
   * the full 90-day daily retention — which is exactly what every dashboard
   * window longer than 7 days reads.
   *
   * The existing idempotency test runs `compactDay` twice over *identical*
   * data, so it structurally cannot see this: the second run has to see less
   * data than the first for the damage to appear.
   */
  it('keeps the daily row intact across the nights that prune its hourly rows', async () => {
    await resetDb(app.prisma);
    const { signatureId: sigId } = await seedSignature();
    await seedFullDay(sigId);

    // A tick mid-morning, not at midnight — the time of day is the bug.
    const night = (n: number) => new Date(Date.UTC(2026, 8, 10 + n, 9, 10));

    await runNightlyJobs({ prisma: app.prisma, now: night(7) });

    const afterFirst = await dailyRow(sigId);
    expect(afterFirst.count).toBe(240);
    expect(Number(afterFirst.totalMs)).toBe(24_000);
    expect(afterFirst.maxMs).toBe(400);
    expect(afterFirst.hist).toEqual([0, 0, 240, 0, 0, 0, 0, 0]);

    // Nothing of the day may be gone yet: its 7-day cutoff is its own midnight.
    expect(
      await app.prisma.queryRollup.count({ where: { signatureId: sigId } }),
    ).toBe(24);

    // Night 8 prunes the day — in one piece — after recompacting it whole.
    await runNightlyJobs({ prisma: app.prisma, now: night(8) });
    expect(
      await app.prisma.queryRollup.count({ where: { signatureId: sigId } }),
    ).toBe(0);

    // Night 9 has no hourly rows left for the day, so it must not revisit it.
    await runNightlyJobs({ prisma: app.prisma, now: night(9) });

    const afterLast = await dailyRow(sigId);
    expect(afterLast.count).toBe(240);
    expect(Number(afterLast.totalMs)).toBe(24_000);
    expect(afterLast.maxMs).toBe(400);
    expect(afterLast.hist).toEqual([0, 0, 240, 0, 0, 0, 0, 0]);
  });
});
