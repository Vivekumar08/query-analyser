import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { runHourlyJobs, runNightlyJobs } from './jobs.js';

const HOURLY_LOCK = 8_100_001;
const NIGHTLY_LOCK = 8_100_002;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Late enough in the hour that the hour's last ingest batches have arrived. */
const HOURLY_AT_MINUTE = 5;

/**
 * Runs `fn` only if it can take the advisory lock, and reports whether it did.
 *
 * It takes a CONNECTION STRING, not the app's `PrismaClient`, and that is the
 * whole fix. `pg_try_advisory_lock` is session-scoped, and the app's client is
 * a `pg.Pool` behind `PrismaPg`: a `$queryRaw` outside a transaction checks
 * out an arbitrary idle client per statement, so lock, job and unlock are
 * three independent checkouts. As soon as the job issues concurrent
 * statements — as a real one does — the pool hands the unlock a *different*
 * session than the one that locked. Postgres answers an unlock from the wrong
 * session with a WARNING, not an error; node-postgres does not throw; the
 * original session keeps the lock; and `withJobLock` returns `true`. Every
 * later tick then logs 'lock held elsewhere', which is indistinguishable from
 * the normal multi-replica case the message was written for — a skipped hourly
 * tick loses that hour's regression alerts permanently, and a skipped nightly
 * tick is a day not compacted.
 *
 * A dedicated `pg.Client` is one connection by definition, which is a stronger
 * guarantee than a second `PrismaClient` capped at a pool of one (and avoids a
 * second query engine for two statements a day). It also means there is no
 * unlock statement that can land on the wrong session at all: `client.end()`
 * closes the session, and Postgres releases every session-level lock the
 * session still holds. That makes process death release the lock too, with no
 * heartbeat row to expire. A `pg_try_advisory_xact_lock` inside
 * `prisma.$transaction` would also pin one connection, but it would hold a
 * transaction — and therefore a snapshot, and therefore vacuum — open for the
 * whole nightly compaction batch; a lock session that runs no queries holds
 * nothing.
 *
 * TEMPORARY. This exists because the scheduler runs in-process and a second
 * replica would otherwise run every job twice. When the jobs move to BullMQ,
 * its job IDs give the same guarantee and this function should be DELETED
 * rather than kept alongside the queue.
 */
export async function withJobLock(
  connectionString: string,
  key: number,
  fn: () => Promise<void>,
  log: { error: (obj: unknown, msg: string) => void } = console,
): Promise<boolean> {
  const client = new pg.Client({ connectionString });
  // `pg.Client` is an EventEmitter and emits 'error' on connection-level
  // failures (server restart, idle_session_timeout, a pooler eviction, a
  // network blip) — failures that are not the rejection of any in-flight
  // query. An EventEmitter 'error' with no listener is a Node uncaught
  // exception, which kills the process. This client sits idle for the
  // entire nightly compaction batch — the longest-running operation the
  // service has, in the unattended path — so it must have a listener
  // attached before `connect()` can possibly race an error in.
  client.on('error', (err) => {
    log.error({ err }, 'analysis job lock connection error');
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [key],
    );
    if (!rows[0]?.locked) return false;
    await fn();
    return true;
  } finally {
    await client.end();
  }
}

/** Milliseconds from `now` until the next `:atMinute` past the hour (UTC-agnostic — minutes past the hour are the same in every zone). */
export function msUntilNextHourAt(now: Date, atMinute: number): number {
  const target = new Date(now.getTime());
  target.setUTCMinutes(atMinute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setTime(target.getTime() + HOUR);
  return target.getTime() - now.getTime();
}

/** Milliseconds from `now` until the next UTC midnight. */
export function msUntilNextUtcMidnight(now: Date): number {
  return (
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()
  );
}

export default fp(async function schedulerPlugin(
  app: FastifyInstance,
  opts: { startScheduler?: boolean },
) {
  const timers: NodeJS.Timeout[] = [];
  app.decorate('analysisTimers', timers);

  let closed = false;
  // Tracks the startup catch-up run (set near the bottom of this plugin) so
  // `onClose` can await it. Without this, `app.close()` races a full nightly
  // job — compaction, pruning, alerts, advice upserts — which, left running,
  // outlives the test (or process) that triggered the close and can touch a
  // shared database other tests still expect to be clean.
  let catchUpPromise: Promise<unknown> | undefined;
  app.addHook('onClose', async () => {
    closed = true;
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    await catchUpPromise;
  });

  if (!opts.startScheduler) return;

  const tick = (name: string, key: number, fn: () => Promise<unknown>) => async () => {
    try {
      const held = await withJobLock(
        app.config.DATABASE_URL,
        key,
        async () => {
          await fn();
        },
        app.log,
      );
      if (!held) app.log.info({ job: name }, 'analysis job skipped, lock held elsewhere');
    } catch (err) {
      // A failing job must never take the service down.
      app.log.error({ err, job: name }, 'analysis job failed');
    }
  };

  const hourly = tick('hourly', HOURLY_LOCK, () => runHourlyJobs({ prisma: app.prisma }));
  const nightly = tick('nightly', NIGHTLY_LOCK, () => runNightlyJobs({ prisma: app.prisma }));

  /**
   * Both jobs are scheduled on the WALL CLOCK, not on an interval counted
   * from process start. `setInterval(fn, 24h)` first fires 24 hours after
   * boot at whatever time the process happened to start, and every deploy
   * resets that phase — so a service deployed once a day may never run
   * `runNightlyJobs` at all: hourly rollups grow without bound,
   * `QueryDailyRollup` stays empty, and every window longer than 7 days
   * answers `items: []` with `grain: 'daily'` rather than an error, which
   * looks like "no traffic" rather than a broken job. Re-arming to the next
   * `:05` / the next UTC midnight also makes the "hourly at :05" promise
   * true, which the interval version only ever described.
   */
  const armHourly = (): void => {
    if (closed) return;
    timers[0] = setTimeout(() => {
      void hourly().finally(armHourly);
    }, msUntilNextHourAt(new Date(), HOURLY_AT_MINUTE));
  };
  const armNightly = (): void => {
    if (closed) return;
    timers[1] = setTimeout(() => {
      void nightly().finally(armNightly);
    }, msUntilNextUtcMidnight(new Date()));
  };

  armHourly();
  armNightly();

  // One catch-up nightly run at startup, behind the same lock. Without it a
  // process that boots after a gap waits until the next midnight before it
  // compacts anything, and the gap's hourly rows sit unpruned the whole time.
  // Every step of the nightly job is already idempotent — `compactDay`
  // replaces rather than accumulates, `detectNewExpensive` is one alert per
  // signature per kind, `refreshAdvice` upserts and now skips unchanged rows —
  // so running it an extra time costs a batch of queries and changes nothing.
  //
  // The advisory lock guards against a *concurrent* stampede — two replicas
  // booting at once — not against repetition. The lock is released when its
  // session ends, which includes the session dying with the process, by
  // design: a crash-looping replica must not hold the lock forever. That
  // means every boot of a crash-looping replica restarts the full nightly
  // batch, which is load amplification at exactly the moment the service is
  // already unhealthy — the lock does not make an extra run cheap, it only
  // makes concurrent extra runs impossible.
  //
  // The promise is held (not `void`-ed) so `onClose` can await it below —
  // otherwise `app.close()` races a full nightly job that can outlive the
  // call and keep writing to a database another test or process already
  // assumes is quiescent.
  catchUpPromise = nightly();
});

declare module 'fastify' {
  interface FastifyInstance {
    analysisTimers: NodeJS.Timeout[];
  }
}
