import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { withJobLock, msUntilNextHourAt, msUntilNextUtcMidnight } from './scheduler.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

/** How many sessions currently hold the session-level advisory lock for `key`. */
async function advisoryLocks(key: number): Promise<number> {
  const [row] = await app.prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM pg_locks
    WHERE locktype = 'advisory' AND classid = 0 AND objid = ${key} AND granted
  `;
  return row?.n ?? 0;
}

describe('withJobLock', () => {
  it('runs the job and reports that it held the lock', async () => {
    let ran = false;
    const held = await withJobLock(app.config.DATABASE_URL, 42, async () => {
      ran = true;
    });
    expect(held).toBe(true);
    expect(ran).toBe(true);
  });

  it('skips the job when another holder has the lock', async () => {
    // Each `withJobLock` call opens its own dedicated session, so nesting one
    // inside another is a genuine second holder — no second client needed.
    let ran = false;
    const held = await withJobLock(app.config.DATABASE_URL, 43, async () => {
      const otherHeld = await withJobLock(app.config.DATABASE_URL, 43, async () => {
        ran = true;
      });
      expect(otherHeld).toBe(false);
    });
    expect(held).toBe(true);
    expect(ran).toBe(false);
  });

  /**
   * The regression test for the leak. The previous implementation took the
   * lock, ran the job and released the lock as three separate `$queryRaw`
   * calls on the app's pooled `PrismaClient`; a job that issues concurrent
   * statements (as every real one does) makes the pool hand the unlock a
   * different session than the one that locked. Postgres answers that with a
   * WARNING rather than an error, node-postgres does not throw, the lock
   * survives, and `withJobLock` still reports success — so every later tick
   * logs 'lock held elsewhere' forever.
   *
   * A quiet test process that never forces a second checkout cannot see this,
   * which is why `fn` here deliberately fans out.
   */
  it('releases the lock even when the job issues concurrent queries', async () => {
    const KEY = 8_100_077;
    expect(await advisoryLocks(KEY)).toBe(0);

    let ran = false;
    const held = await withJobLock(app.config.DATABASE_URL, KEY, async () => {
      // Enough concurrent statements to force the pool past one client.
      await Promise.all(
        Array.from({ length: 8 }, () => app.prisma.$queryRaw`SELECT pg_sleep(0.05)::text AS slept`),
      );
      ran = true;
    });

    expect(held).toBe(true);
    expect(ran).toBe(true);
    expect(await advisoryLocks(KEY)).toBe(0);

    // And the consequence that actually hurt: the next tick must get the lock.
    let second = false;
    const again = await withJobLock(app.config.DATABASE_URL, KEY, async () => {
      second = true;
    });
    expect(again).toBe(true);
    expect(second).toBe(true);
  });

  it('releases the lock when the job throws', async () => {
    const KEY = 8_100_078;
    await expect(
      withJobLock(app.config.DATABASE_URL, KEY, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await advisoryLocks(KEY)).toBe(0);
  });
});

describe('wall-clock scheduling', () => {
  it('fires hourly at the next :05, not an hour after boot', () => {
    expect(msUntilNextHourAt(new Date('2026-09-20T09:00:00.000Z'), 5)).toBe(5 * 60_000);
    expect(msUntilNextHourAt(new Date('2026-09-20T09:04:30.000Z'), 5)).toBe(30_000);
    // Exactly on :05 means the next one, never a zero-delay re-entry loop.
    expect(msUntilNextHourAt(new Date('2026-09-20T09:05:00.000Z'), 5)).toBe(60 * 60_000);
    expect(msUntilNextHourAt(new Date('2026-09-20T09:06:00.000Z'), 5)).toBe(59 * 60_000);
  });

  it('fires nightly at the next UTC midnight, not 24h after boot', () => {
    expect(msUntilNextUtcMidnight(new Date('2026-09-20T00:00:00.000Z'))).toBe(24 * 3_600_000);
    expect(msUntilNextUtcMidnight(new Date('2026-09-20T23:30:00.000Z'))).toBe(30 * 60_000);
    // Across a month boundary, which is why this uses Date.UTC and not arithmetic.
    expect(msUntilNextUtcMidnight(new Date('2026-09-30T22:00:00.000Z'))).toBe(2 * 3_600_000);
  });
});

describe('scheduler registration', () => {
  it('does not start timers unless asked', async () => {
    // Tests build dozens of apps; none of them should spawn background work.
    const quiet = await buildApp();
    expect(quiet.analysisTimers).toHaveLength(0);
    await quiet.close();
  });

  it('starts timers when startScheduler is true', async () => {
    const busy = await buildApp({ startScheduler: true });
    expect(busy.analysisTimers.length).toBeGreaterThan(0);
    await busy.close();
  });
});
