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

async function signup(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'V' },
  });
  return res.json().accessToken as string;
}

/** Reads the one outstanding token for a user straight from the database. */
async function tokenFor(email: string, purpose: 'VERIFY' | 'RESET') {
  const u = await app.prisma.user.findUniqueOrThrow({ where: { email } });
  return app.prisma.verificationToken.findFirst({
    where: { userId: u.id, purpose, consumedAt: null },
  });
}

/**
 * `password/request` replies before it sends, so the mail lands after inject
 * resolves. Poll rather than sleep: a fixed sleep is either flaky or slow.
 */
async function waitForMail(app: FastifyInstance, atLeast: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (app.sentMail.length < atLeast) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for mail #${atLeast}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('verification', () => {
  it('signup issues a verification token and leaves the user unverified', async () => {
    const email = `v1-${Date.now()}@x.io`;
    await signup(email);
    const u = await app.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.emailVerifiedAt).toBeNull();
    expect(await tokenFor(email, 'VERIFY')).not.toBeNull();
  });

  it('confirms with a valid token and is idempotent on reuse', async () => {
    const email = `v2-${Date.now()}@x.io`;
    const token = await signup(email);
    const row = await tokenFor(email, 'VERIFY');
    expect(row).not.toBeNull();

    // The plaintext is not readable from the row, so request a fresh one
    // through the resend endpoint and capture it from the mail fake instead.
    const resend = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify/request',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resend.statusCode).toBe(202);

    const sent = app.sentMail.at(-1);
    expect(sent).toBeDefined();
    const plaintext = /token=([A-Za-z0-9_-]+)/.exec(sent!.text)?.[1];
    expect(plaintext).toBeTruthy();

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify/confirm',
      payload: { token: plaintext },
    });
    expect(ok.statusCode).toBe(200);

    const u = await app.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.emailVerifiedAt).not.toBeNull();

    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify/confirm',
      payload: { token: plaintext },
    });
    expect(again.statusCode).toBe(400);
  });
});

describe('password reset', () => {
  it('resets the password and revokes every refresh token', async () => {
    const email = `p1-${Date.now()}@x.io`;
    await signup(email);

    const req = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/request',
      payload: { email },
    });
    expect(req.statusCode).toBe(202);

    await waitForMail(app, 2); // signup's verify mail, then this reset mail
    const sent = app.sentMail.at(-1)!;
    const plaintext = /token=([A-Za-z0-9_-]+)/.exec(sent.text)![1];

    const done = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/confirm',
      payload: { token: plaintext, password: 'a-completely-new-password-1' },
    });
    expect(done.statusCode).toBe(200);

    const u = await app.prisma.user.findUniqueOrThrow({ where: { email } });
    const live = await app.prisma.refreshToken.count({ where: { userId: u.id, consumedAt: null } });
    expect(live).toBe(0);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'a-completely-new-password-1' },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe('account enumeration', () => {
  // This test documents the intended property rather than independently
  // gating it: the handler sends a single unconditional `reply.code(202).send(...)`
  // literal before `email` is ever looked up, so there is no realistic
  // single-edit mutation that flips the status/body here without also
  // failing "does not wait for the mail to send" below — that latency test is
  // the actual gate. Kept anyway because it still catches a *reordering* of
  // the handler (lookup moved before the reply) — in that case both tests
  // fail together, which is useful signal — but a future reader must not
  // mistake this test for a second, independent line of defence.
  it('answers identically for a known and an unknown email', async () => {
    const known = `e1-${Date.now()}@x.io`;
    await signup(known);

    const a = await app.inject({ method: 'POST', url: '/v1/auth/password/request', payload: { email: known } });
    const b = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/request',
      payload: { email: `nobody-${Date.now()}@x.io` },
    });

    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json()).toEqual(b.json());
  });

  it('does not wait for the mail to send, so latency carries no signal', async () => {
    // If the handler awaited SMTP only when the account exists, response time
    // would leak existence even with identical bodies.
    const known = `e2-${Date.now()}@x.io`;
    await signup(known);
    app.mailDelayMs = 400;

    const started = Date.now();
    await app.inject({ method: 'POST', url: '/v1/auth/password/request', payload: { email: known } });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(300);
    app.mailDelayMs = 0;
  });
});
