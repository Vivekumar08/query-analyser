import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../db.js';
import { runHourlyJobs, runNightlyJobs } from './jobs.js';

const HOURLY_LOCK = 8_100_001;
const NIGHTLY_LOCK = 8_100_002;
const MINUTE = 60_000;

/**
 * Runs `fn` only if this connection can take the advisory lock, and reports
 * whether it did.
 *
 * TEMPORARY. This exists because the scheduler runs in-process and a second
 * replica would otherwise run every job twice. When the jobs move to BullMQ,
 * its job IDs give the same guarantee and this function should be DELETED
 * rather than kept alongside the queue.
 */
export async function withJobLock(
  prisma: PrismaClient,
  key: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${key}::bigint) AS locked
  `;
  if (!row?.locked) return false;
  try {
    await fn();
    return true;
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${key}::bigint)`;
  }
}

export default fp(async function schedulerPlugin(
  app: FastifyInstance,
  opts: { startScheduler?: boolean },
) {
  const timers: NodeJS.Timeout[] = [];
  app.decorate('analysisTimers', timers);

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  });

  if (!opts.startScheduler) return;

  const tick = (name: string, key: number, fn: () => Promise<unknown>) => async () => {
    try {
      const held = await withJobLock(app.prisma, key, async () => {
        await fn();
      });
      if (!held) app.log.info({ job: name }, 'analysis job skipped, lock held elsewhere');
    } catch (err) {
      // A failing job must never take the service down.
      app.log.error({ err, job: name }, 'analysis job failed');
    }
  };

  // Hourly at :05 — late enough that the hour's last batches have arrived.
  const hourly = tick('hourly', HOURLY_LOCK, () => runHourlyJobs({ prisma: app.prisma }));
  const nightly = tick('nightly', NIGHTLY_LOCK, () => runNightlyJobs({ prisma: app.prisma }));

  timers.push(setInterval(() => void hourly(), 60 * MINUTE));
  timers.push(setInterval(() => void nightly(), 24 * 60 * MINUTE));
});

declare module 'fastify' {
  interface FastifyInstance {
    analysisTimers: NodeJS.Timeout[];
  }
}
