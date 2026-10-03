import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { withJobLock } from './scheduler.js';
import { createPrisma } from '../db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe('withJobLock', () => {
  it('runs the job and reports that it held the lock', async () => {
    let ran = false;
    const held = await withJobLock(app.prisma, 42, async () => {
      ran = true;
    });
    expect(held).toBe(true);
    expect(ran).toBe(true);
  });

  it('skips the job when another holder has the lock', async () => {
    // PostgreSQL advisory locks are session-scoped and re-entrant: taking
    // the same key twice on the SAME connection succeeds. A second holder
    // only exists with a second, independent session, so this test opens a
    // second PrismaClient (its own pool/connection) against the same
    // database rather than nesting withJobLock on `app.prisma`.
    const other = createPrisma('postgresql://qa:qa@localhost:5432/qa');
    try {
      let ran = false;
      const held = await withJobLock(app.prisma, 43, async () => {
        const otherHeld = await withJobLock(other, 43, async () => {
          ran = true;
        });
        expect(otherHeld).toBe(false);
      });
      expect(held).toBe(true);
      expect(ran).toBe(false);
    } finally {
      await other.$disconnect();
    }
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
