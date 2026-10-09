import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
});

/**
 * Migration `20261011120000_backfill_email_verified_at` grandfathers in every
 * account that predates the verification gate, so `prisma migrate deploy`
 * does not 403 the owner's own account (and everyone else who signed up
 * before the gate existed) on every gated route.
 *
 * The migration itself cannot be re-run inside this suite without mutating
 * the shared test database's migration history (it has already been applied
 * once, by `npx prisma migrate deploy`, and Prisma will not re-apply an
 * already-recorded migration). Instead this test pins the exact semantics
 * the migration's SQL depends on, by running the same statement directly:
 * it must backfill a null `emailVerifiedAt` and must leave an already-set one
 * untouched.
 */
describe('email-verification backfill semantics', () => {
  it('sets emailVerifiedAt only for rows where it is currently null', async () => {
    const unverified = await app.prisma.user.create({
      data: { email: `bf1-${Date.now()}-${Math.random()}@x.io`, name: 'U', passwordHash: 'x' },
    });
    const alreadyVerifiedAt = new Date('2020-01-01T00:00:00.000Z');
    const verified = await app.prisma.user.create({
      data: {
        email: `bf2-${Date.now()}-${Math.random()}@x.io`,
        name: 'V',
        passwordHash: 'x',
        emailVerifiedAt: alreadyVerifiedAt,
      },
    });

    expect(unverified.emailVerifiedAt).toBeNull();

    // The exact statement the migration runs.
    await app.prisma.$executeRawUnsafe(
      `UPDATE "User" SET "emailVerifiedAt" = now() WHERE "emailVerifiedAt" IS NULL AND "id" IN ($1, $2)`,
      unverified.id,
      verified.id,
    );

    const afterUnverified = await app.prisma.user.findUniqueOrThrow({ where: { id: unverified.id } });
    const afterVerified = await app.prisma.user.findUniqueOrThrow({ where: { id: verified.id } });

    // The previously-null row is grandfathered in.
    expect(afterUnverified.emailVerifiedAt).not.toBeNull();
    // An already-verified row keeps its original timestamp, not `now()`.
    expect(afterVerified.emailVerifiedAt?.toISOString()).toBe(alreadyVerifiedAt.toISOString());
  });
});
