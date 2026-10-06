import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import {
  issueVerificationToken,
  consumeVerificationToken,
  VERIFY_TTL_MS,
  RESET_TTL_MS,
} from './verification.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
});

const user = () =>
  app.prisma.user.create({
    data: { email: `ver-${Date.now()}-${Math.random()}@x.io`, name: 'V', passwordHash: 'x' },
  });

describe('token lifetimes', () => {
  it('gives a reset link an hour and a verification link a day', () => {
    // A reset link is a password in disguise; it should live for minutes, not
    // days. Verification is not a credential in the same way.
    expect(RESET_TTL_MS).toBe(3_600_000);
    expect(VERIFY_TTL_MS).toBe(86_400_000);
    expect(RESET_TTL_MS).toBeLessThan(VERIFY_TTL_MS);
  });
});

describe('issueVerificationToken', () => {
  it('never stores the plaintext it returns', async () => {
    const u = await user();
    const { token } = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    const rows = await app.prisma.verificationToken.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toHaveLength(64);
  });

  it('consumes any outstanding token of the same purpose', async () => {
    // An old link sitting in an old inbox must stop working once a new one is
    // requested.
    const u = await user();
    const first = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    expect(await consumeVerificationToken(app.prisma, first.token, 'VERIFY')).toBeNull();
  });

  it('leaves a token of a different purpose alone', async () => {
    const u = await user();
    const reset = await issueVerificationToken(app.prisma, u.id, 'RESET');
    await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    expect(await consumeVerificationToken(app.prisma, reset.token, 'RESET')).toBe(u.id);
  });
});

describe('consumeVerificationToken', () => {
  it('returns the user id once and null thereafter', async () => {
    const u = await user();
    const { token } = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    expect(await consumeVerificationToken(app.prisma, token, 'VERIFY')).toBe(u.id);
    expect(await consumeVerificationToken(app.prisma, token, 'VERIFY')).toBeNull();
  });

  it('rejects an unknown token', async () => {
    expect(await consumeVerificationToken(app.prisma, 'not-a-real-token', 'VERIFY')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const u = await user();
    const { token } = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    await app.prisma.verificationToken.updateMany({
      where: { userId: u.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeVerificationToken(app.prisma, token, 'VERIFY')).toBeNull();
  });

  it('rejects a token presented against the wrong purpose', async () => {
    // A verification link must not be usable to set a password.
    const u = await user();
    const { token } = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    expect(await consumeVerificationToken(app.prisma, token, 'RESET')).toBeNull();
  });
});
