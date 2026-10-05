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

async function user(email: string) {
  return app.prisma.user.create({
    data: { email, name: 'Schema', passwordHash: 'x' },
  });
}

describe('VerificationToken schema', () => {
  it('stores a token with a purpose and an expiry, unverified by default', async () => {
    const u = await user(`sch-${Date.now()}@x.io`);
    expect(u.emailVerifiedAt).toBeNull();

    const row = await app.prisma.verificationToken.create({
      data: {
        userId: u.id,
        tokenHash: `hash-${Date.now()}`,
        purpose: 'VERIFY',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(row.purpose).toBe('VERIFY');
    expect(row.consumedAt).toBeNull();
  });

  it('rejects a duplicate tokenHash', async () => {
    const u = await user(`dup-${Date.now()}@x.io`);
    const hash = `dup-hash-${Date.now()}`;
    const base = { userId: u.id, tokenHash: hash, purpose: 'RESET' as const, expiresAt: new Date(Date.now() + 3_600_000) };
    await app.prisma.verificationToken.create({ data: base });
    await expect(app.prisma.verificationToken.create({ data: base })).rejects.toThrow();
  });

  it('cascades when the user is deleted', async () => {
    const u = await user(`cas-${Date.now()}@x.io`);
    await app.prisma.verificationToken.create({
      data: { userId: u.id, tokenHash: `cas-${Date.now()}`, purpose: 'VERIFY', expiresAt: new Date(Date.now() + 1000) },
    });
    await app.prisma.user.delete({ where: { id: u.id } });
    expect(await app.prisma.verificationToken.count({ where: { userId: u.id } })).toBe(0);
  });
});
