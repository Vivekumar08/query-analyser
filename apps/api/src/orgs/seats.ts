import type { PrismaClient } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * The org's seat usage. A seat is a distinct person: `emails` is every
 * member's email plus every pending, unexpired invite's email, lowercased,
 * and `used` is how many of them there are beyond one owner.
 *
 * An invite to an email already in `emails` adds no person, so it never
 * needs a seat. Call this under `lockOrg` when the answer gates a write, so
 * two concurrent invites can't both see the last free seat.
 */
export async function seatState(
  db: Prisma.TransactionClient | PrismaClient,
  orgId: string,
  now: Date = new Date(),
): Promise<{ used: number; emails: Set<string> }> {
  const members = await db.membership.findMany({ where: { orgId }, select: { user: { select: { email: true } } } });
  const invites = await db.invite.findMany({
    where: { orgId, acceptedAt: null, expiresAt: { gt: now } },
    distinct: ['email'],
    select: { email: true },
  });
  const emails = new Set<string>([
    ...members.map((m) => m.user.email.toLowerCase()),
    ...invites.map((i) => i.email.toLowerCase()),
  ]);
  return { used: Math.max(0, emails.size - 1), emails };
}
