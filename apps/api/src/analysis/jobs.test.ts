import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb } from '../test/db.js';
import type { OpClass } from '@query-analyser/contract/runtime';

// `vi.spyOn(compaction, 'compactDay')` cannot work here: Vitest cannot
// redefine bindings on a native ES module namespace object, so the spy
// either throws or silently fails to intercept. A silently-failing spy
// would make the detect-before-prune ordering test pass unconditionally —
// the one failure mode this task exists to prevent. `vi.mock` replaces the
// module before `jobs.ts` imports it, so the mock genuinely intercepts.
vi.mock('./compaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./compaction.js')>();
  return {
    ...actual,
    compactDay: vi.fn(async () => 0),
    pruneHourly: vi.fn(async () => 0),
    pruneDaily: vi.fn(async () => 0),
  };
});

const { buildApp } = await import('../app.js');
const { runHourlyJobs, runNightlyJobs } = await import('./jobs.js');
const compaction = await import('./compaction.js');

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
  await resetDb(app.prisma);
  // `mockReset` (not `mockClear`) so a `mockImplementation` set by one test
  // can never leak into the next test's default behaviour.
  vi.mocked(compaction.compactDay).mockReset().mockResolvedValue(0);
  vi.mocked(compaction.pruneHourly).mockReset().mockResolvedValue(0);
  vi.mocked(compaction.pruneDaily).mockReset().mockResolvedValue(0);
});

afterAll(async () => {
  await app?.close();
});

/**
 * `runNightlyJobs` only calls `compactDay` when there is at least one hourly
 * rollup left to compact. Without seeding one, the ordering assertion below
 * would pass vacuously (compactDay never called, so its index is always -1,
 * which is "less than" any prune index) regardless of the real call order —
 * exactly the silent-pass failure mode this task guards against.
 */
async function seedRollup(bucketHour: Date) {
  const org = await app.prisma.organization.create({
    data: { name: 'Jobs Co', slug: `jobs-${Date.now()}-${Math.random()}` },
  });
  const a = await app.prisma.app.create({
    data: { orgId: org.id, name: 'jobs', env: 'production' },
  });
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: a.id,
      hash: `h${Date.now()}${Math.random()}`.slice(0, 16).padEnd(16, '0'),
      signature: 'users.find({email})',
      model: 'users',
      operation: 'find',
      filterShape: [{ key: 'email', op: 'eq' }],
      sortKeys: [],
      stages: [],
    },
  });
  await app.prisma.queryRollup.create({
    data: {
      signatureId: sig.id,
      bucketHour,
      count: 1,
      totalMs: 10n,
      maxMs: 10,
      hist: [1, 0, 0, 0, 0, 0, 0, 0],
    },
  });
}

describe('runNightlyJobs', () => {
  it('detects before it prunes', async () => {
    // Hourly rollups are kept 7 days and the regression baseline is a 7-day
    // median — exactly equal. Pruning first silently drops the oldest hour
    // out of every baseline.
    await seedRollup(new Date('2026-09-19T03:00:00.000Z'));

    const order: string[] = [];
    vi.mocked(compaction.compactDay).mockImplementation(async () => {
      order.push('compact');
      return 0;
    });
    vi.mocked(compaction.pruneHourly).mockImplementation(async () => {
      order.push('prune');
      return 0;
    });
    vi.mocked(compaction.pruneDaily).mockImplementation(async () => 0);

    await runNightlyJobs({ prisma: app.prisma, now: new Date('2026-09-20T02:00:00.000Z') });

    expect(compaction.compactDay).toHaveBeenCalled();
    expect(order.indexOf('compact')).toBeLessThan(order.indexOf('prune'));
  });

  it('prunes hourly at 7 days and daily at 90 days from now', async () => {
    await seedRollup(new Date('2026-09-19T03:00:00.000Z'));

    const seen: Date[] = [];
    vi.mocked(compaction.compactDay).mockResolvedValue(0);
    vi.mocked(compaction.pruneHourly).mockImplementation(async (_p, before) => {
      seen.push(before);
      return 0;
    });
    vi.mocked(compaction.pruneDaily).mockImplementation(async (_p, before) => {
      seen.push(before);
      return 0;
    });

    const now = new Date('2026-09-20T02:00:00.000Z');
    await runNightlyJobs({ prisma: app.prisma, now });

    expect(seen[0]?.toISOString()).toBe('2026-09-13T02:00:00.000Z');
    expect(seen[1]?.toISOString()).toBe('2026-06-22T02:00:00.000Z');
  });
});

/**
 * Creates an org/app/signature with the given filter shape and sort keys,
 * independent of any rollup data. Used to drive `refreshAdvice` through
 * `runNightlyJobs`.
 */
async function seedSignature(
  filterShape: { key: string; op: OpClass }[],
  sortKeys: { key: string; dir: 1 | -1 }[],
) {
  const org = await app.prisma.organization.create({
    data: { name: 'Advice Co', slug: `advice-${Date.now()}-${Math.random()}` },
  });
  const a = await app.prisma.app.create({
    data: { orgId: org.id, name: 'advice', env: 'production' },
  });
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: a.id,
      hash: `h${Date.now()}${Math.random()}`.slice(0, 16).padEnd(16, '0'),
      signature: 'advice.find({x})',
      model: 'advice',
      operation: 'find',
      filterShape,
      sortKeys,
      stages: [],
    },
  });
  return sig.id;
}

describe('refreshAdvice (via runNightlyJobs)', () => {
  it('leaves DISMISSED advice untouched, creates advice for a fresh indexable signature, and writes nothing for a non-indexable one', async () => {
    // Dismissed: indexable filter shape, so if the DISMISSED guard were
    // removed, `adviceFor` would compute a *different* suggestion/rationale
    // than the one seeded below — making the mutation check meaningful.
    const dismissedId = await seedSignature([{ key: 'email', op: 'eq' }], []);
    const dismissedAdvice = await app.prisma.advice.create({
      data: {
        signatureId: dismissedId,
        status: 'DISMISSED',
        suggestion: { untouched: 1 },
        rationale: 'manually dismissed — should never be overwritten',
      },
    });

    // Fresh signature with an indexable shape and no existing advice row.
    const freshId = await seedSignature(
      [{ key: 'status', op: 'eq' }],
      [{ key: 'createdAt', dir: -1 }],
    );

    // Non-indexable: empty filter shape and no sort keys — `adviceFor`
    // returns null, so nothing should be written.
    const nullId = await seedSignature([], []);

    const result = await runNightlyJobs({
      prisma: app.prisma,
      now: new Date('2026-09-20T02:00:00.000Z'),
    });

    // Only the fresh signature produced advice.
    expect(result.adviceWritten).toBe(1);

    const dismissedAfter = await app.prisma.advice.findUniqueOrThrow({
      where: { signatureId: dismissedId },
    });
    expect(dismissedAfter.status).toBe('DISMISSED');
    expect(dismissedAfter.suggestion).toEqual({ untouched: 1 });
    expect(dismissedAfter.rationale).toBe(dismissedAdvice.rationale);
    expect(dismissedAfter.updatedAt.getTime()).toBe(dismissedAdvice.updatedAt.getTime());

    const freshAfter = await app.prisma.advice.findUnique({ where: { signatureId: freshId } });
    expect(freshAfter).not.toBeNull();
    expect(freshAfter?.status).toBe('OPEN');
    expect(freshAfter?.suggestion).toEqual({ status: 1, createdAt: -1 });

    const nullAfter = await app.prisma.advice.findUnique({ where: { signatureId: nullId } });
    expect(nullAfter).toBeNull();
  });
});

describe('runHourlyJobs', () => {
  it('returns a result without throwing when there is no data at all', async () => {
    const r = await runHourlyJobs({
      prisma: app.prisma,
      now: new Date('2026-09-20T02:00:00.000Z'),
    });
    expect(r.alertsCreated).toBe(0);
  });

  /**
   * `now` is deliberately mid-hour: `runHourlyJobs` computes `lastComplete`
   * as the start of `now`'s hour minus one hour, so with
   * now = 2026-09-20T03:30, lastComplete = 2026-09-20T02:00. Trailing hours
   * sit in the preceding days, well inside the 7-day window.
   */
  const NOW = new Date('2026-09-20T03:30:00.000Z');
  const LAST_COMPLETE = new Date('2026-09-20T02:00:00.000Z');
  const TRAILING_HOURS = [
    new Date('2026-09-19T02:00:00.000Z'),
    new Date('2026-09-18T02:00:00.000Z'),
    new Date('2026-09-17T02:00:00.000Z'),
  ];

  /**
   * Trailing hours: 20 observations concentrated in the [0,100) bucket —
   * p95 interpolates to ~95ms. Latest hour: `latestCount` observations
   * concentrated in the [500,1000) bucket — p95 interpolates to ~975ms,
   * comfortably more than 2x the ~95ms trailing median.
   */
  async function seedRegressionCandidate(latestCount: number) {
    const sigId = await seedSignature([{ key: 'email', op: 'eq' }], []);
    await app.prisma.queryRollup.createMany({
      data: TRAILING_HOURS.map((bucketHour) => ({
        signatureId: sigId,
        bucketHour,
        count: 20,
        totalMs: 20n * 90n,
        maxMs: 99,
        hist: [20, 0, 0, 0, 0, 0, 0, 0],
      })),
    });
    await app.prisma.queryRollup.create({
      data: {
        signatureId: sigId,
        bucketHour: LAST_COMPLETE,
        count: latestCount,
        totalMs: BigInt(latestCount) * 975n,
        maxMs: 999,
        hist: [0, 0, 0, latestCount, 0, 0, 0, 0],
      },
    });
    return sigId;
  }

  it('creates a regression alert when the latest p95 exceeds 2x the trailing median and the count floor is met', async () => {
    const sigId = await seedRegressionCandidate(25);

    const r = await runHourlyJobs({ prisma: app.prisma, now: NOW });

    expect(r.alertsCreated).toBe(1);
    const alerts = await app.prisma.alert.findMany({ where: { signatureId: sigId } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe('regression');
  });

  it('creates no alert when the same p95 jump does not meet the minimum count floor', async () => {
    const sigId = await seedRegressionCandidate(10);

    const r = await runHourlyJobs({ prisma: app.prisma, now: NOW });

    expect(r.alertsCreated).toBe(0);
    const alerts = await app.prisma.alert.findMany({ where: { signatureId: sigId } });
    expect(alerts).toHaveLength(0);
  });
});
