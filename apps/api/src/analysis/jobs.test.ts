import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb } from '../test/db.js';

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
  vi.mocked(compaction.compactDay).mockClear();
  vi.mocked(compaction.pruneHourly).mockClear();
  vi.mocked(compaction.pruneDaily).mockClear();
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

describe('runHourlyJobs', () => {
  it('returns a result without throwing when there is no data at all', async () => {
    const r = await runHourlyJobs({
      prisma: app.prisma,
      now: new Date('2026-09-20T02:00:00.000Z'),
    });
    expect(r.alertsCreated).toBe(0);
  });
});
