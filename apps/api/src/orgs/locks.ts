/**
 * Row locks taken inside transactions that check a limit or an invariant.
 *
 * Lock order is always: the `Organization` row first, then `Membership`
 * rows. Every caller follows it, so two transactions can never wait on each
 * other in a cycle. `lockUser` guards the per-user orgs limit and is never
 * taken together with an org lock.
 */
import { Prisma } from '../generated/prisma/client.js';

/** Locks the org row and returns its plan, or null when there is no such org. */
export async function lockOrg(tx: Prisma.TransactionClient, orgId: string): Promise<{ plan: string } | null> {
  const rows = await tx.$queryRaw<{ plan: string }[]>`SELECT plan FROM "Organization" WHERE id = ${orgId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Locks the user row, serialising that user's org creations. */
export async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
}

/**
 * One ordered `FOR UPDATE` over the org's OWNER rows plus the target row,
 * taken before anything looks at the target's role. Deciding from the
 * locked rows means the target's role can't change under us and the
 * owners we count stay owners until we commit, so no concurrent promote,
 * demote, removal or leave can leave the org with zero owners. Every
 * caller locks through this one statement in id order, so there is a
 * single lock order and no cycle. (Locking the owners first and then
 * re-reading the target would deadlock against a concurrent demotion of
 * a just-promoted target.)
 */
export async function lockOwnersAndTarget(
  tx: Prisma.TransactionClient,
  orgId: string,
  target: { id: string } | { userId: string },
): Promise<{ row?: { id: string; userId: string; role: string }; ownerCount: number }> {
  const match = 'id' in target ? Prisma.sql`id = ${target.id}` : Prisma.sql`"userId" = ${target.userId}`;
  const rows = await tx.$queryRaw<{ id: string; userId: string; role: string }[]>`
    SELECT id, "userId", role::text AS role FROM "Membership"
    WHERE "orgId" = ${orgId} AND (role = 'OWNER'::"Role" OR ${match})
    ORDER BY id FOR UPDATE`;
  const row = rows.find((r) => ('id' in target ? r.id === target.id : r.userId === target.userId));
  return { row, ownerCount: rows.filter((r) => r.role === 'OWNER').length };
}
