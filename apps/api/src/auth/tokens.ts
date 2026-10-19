import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';

/** The client itself, or a transaction handle from `prisma.$transaction(async (tx) => …)`. */
type Db = PrismaClient | Prisma.TransactionClient;

export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function issueRefreshToken(prisma: Db, userId: string, familyId: string = randomUUID()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await prisma.refreshToken.create({ data: { userId, familyId, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt, familyId };
}

export type RotateResult = { userId: string; token: string; expiresAt: Date } | 'reused' | 'invalid';

/**
 * Consume `token` and issue its successor in the same family.
 * A token that was already consumed is a replay: revoke the entire family.
 */
export async function rotateRefreshToken(
  prisma: PrismaClient,
  token: string,
  /** @internal Test seam: runs between the consume and the successor insert. Never passed by a route. */
  opts: { afterConsume?: () => Promise<void> } = {},
): Promise<RotateResult> {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return 'invalid';

  // An expired token being presented is as much an anomaly as a replayed
  // one — revoke the whole family rather than silently accepting that this
  // one token is merely stale.
  if (row.expiresAt < new Date()) {
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, consumedAt: null }, data: { consumedAt: new Date() } });
    return 'invalid';
  }

  if (row.consumedAt) {
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, consumedAt: null }, data: { consumedAt: new Date() } });
    return 'reused';
  }

  // Consume and issue the successor in one transaction, holding the User row
  // lock that a password change (and reset confirm) also takes before it
  // revokes tokens. Without it, a rotation that has consumed the old token
  // but not yet stored the successor lets the revocation run in between, and
  // the successor lands live after it. With it, the two serialise: either the
  // revocation sees (and kills) the successor, or the CAS below sees the
  // revoked token and fails.
  return prisma.$transaction(async (tx) => {
    // NO KEY UPDATE, not UPDATE: it still conflicts with the password-change
    // lock, but not with the KEY SHARE lock every FK insert referencing this
    // user takes (a reset link, a membership), which FOR UPDATE would block
    // and, with the reset-link transaction, deadlock against.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${row.userId} FOR NO KEY UPDATE`;

    // Atomic consume: only one concurrent caller wins.
    const consumed = await tx.refreshToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count === 0) return 'reused' as const;
    await opts.afterConsume?.();

    const next = await issueRefreshToken(tx, row.userId, row.familyId);
    return { userId: row.userId, token: next.token, expiresAt: next.expiresAt };
  });
}

export async function consumeRefreshToken(prisma: PrismaClient, token: string): Promise<void> {
  await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token), consumedAt: null }, data: { consumedAt: new Date() } });
}
