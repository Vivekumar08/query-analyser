import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, TokenPurpose } from '../db.js';

/** A verification link is not a credential in the way a reset link is. */
export const VERIFY_TTL_MS = 24 * 3600 * 1000;
/** A reset link is a password in disguise. Minutes, not days. */
export const RESET_TTL_MS = 3600 * 1000;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const ttlFor = (purpose: TokenPurpose) => (purpose === 'RESET' ? RESET_TTL_MS : VERIFY_TTL_MS);

/**
 * Issues a single-use token, returning the plaintext exactly once.
 *
 * Any outstanding token of the same purpose is consumed first, so requesting a
 * new link invalidates the old one sitting in an old inbox.
 */
export async function issueVerificationToken(
  prisma: PrismaClient,
  userId: string,
  purpose: TokenPurpose,
): Promise<{ token: string; expiresAt: Date }> {
  await prisma.verificationToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlFor(purpose));
  await prisma.verificationToken.create({
    data: { userId, purpose, tokenHash: hashToken(token), expiresAt },
  });
  return { token, expiresAt };
}

/**
 * Consumes a token and returns the user it belongs to, or null.
 *
 * The claim is a single atomic `updateMany` guarded on `consumedAt: null` and
 * an unexpired `expiresAt`: `count === 0` means spent, expired, unknown, or
 * the wrong purpose, and the caller cannot tell which. Read-then-write here
 * would be the same defect the invite flow was fixed for.
 */
export async function consumeVerificationToken(
  prisma: PrismaClient,
  token: string,
  purpose: TokenPurpose,
): Promise<string | null> {
  const tokenHash = hashToken(token);
  const claimed = await prisma.verificationToken.updateMany({
    where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const row = await prisma.verificationToken.findUnique({
    where: { tokenHash },
    select: { userId: true },
  });
  return row?.userId ?? null;
}
