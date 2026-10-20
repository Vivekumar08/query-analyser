import type { PrismaClient } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Resolves once `pending` has settled, or once some backend is waiting on a
 * lock held by `holder`'s backend (i.e. `pending` is blocked behind it). A
 * signal, not a timeout: no wall-clock guess about how long the request
 * takes on this machine, and no false "blocked" from an unrelated lock
 * waiter. `observer` must be a connection outside `holder`'s transaction.
 */
export async function settledOrBlocked(
  observer: PrismaClient,
  pending: Promise<unknown>,
  holder: Prisma.TransactionClient,
): Promise<'settled' | 'blocked'> {
  const [me] = await holder.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  const pid = me!.pid;
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 30_000;
  while (!settled) {
    const [row] = await observer.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if (row!.n > 0) return 'blocked';
    if (Date.now() > deadline) throw new Error('neither settled nor blocked');
    await new Promise((r) => setTimeout(r, 5));
  }
  return 'settled';
}
