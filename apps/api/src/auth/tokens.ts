import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '../db.js';

export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function issueRefreshToken(prisma: PrismaClient, userId: string, familyId: string = randomUUID()) {
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
export async function rotateRefreshToken(prisma: PrismaClient, token: string): Promise<RotateResult> {
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

  // Atomic consume: only one concurrent caller wins.
  const consumed = await prisma.refreshToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count === 0) return 'reused';

  const next = await issueRefreshToken(prisma, row.userId, row.familyId);
  return { userId: row.userId, token: next.token, expiresAt: next.expiresAt };
}

export async function consumeRefreshToken(prisma: PrismaClient, token: string): Promise<void> {
  await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token), consumedAt: null }, data: { consumedAt: new Date() } });
}
