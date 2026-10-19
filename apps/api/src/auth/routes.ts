import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './password.js';
import { issueRefreshToken, rotateRefreshToken, consumeRefreshToken, REFRESH_TTL_MS } from './tokens.js';
import { issueVerificationToken, consumeVerificationToken, VERIFY_TTL_MS, RESET_TTL_MS } from './verification.js';
import { verifyEmail, resetPasswordEmail } from '../mail/templates.js';
import type { PrismaClient } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';

/** The lock both password writers and every refresh-token issuer take on the User row. See `rotateRefreshToken`. */
const lockUser = (tx: Prisma.TransactionClient, userId: string) =>
  tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;

/**
 * Store a new password hash and end every way back in under the old one:
 * every refresh token and every outstanding reset link. Holds the User row
 * lock that `rotateRefreshToken` takes, so a refresh in flight cannot slip a
 * live successor in behind the revocation.
 *
 * With `expectedHash`, the write is a compare-and-swap: if the stored hash is
 * no longer the one the caller verified against (another change won the
 * race), nothing is written, revoked or issued and this returns null.
 *
 * With `issueSession`, the caller's new refresh token is issued inside the
 * same transaction, after the revocation and while the lock is still held.
 * Issued after the commit instead, a later password writer (a reset confirm)
 * could revoke everything in between and this stale token would land live.
 */
async function replacePassword(
  prisma: PrismaClient,
  userId: string,
  passwordHash: string,
  opts: { expectedHash?: string; issueSession?: boolean; beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void> } = {},
): Promise<{ refreshToken: string | null } | null> {
  const { expectedHash, issueSession = false, beforeCommit } = opts;
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const updated = await tx.user.updateMany({
      where: { id: userId, ...(expectedHash === undefined ? {} : { passwordHash: expectedHash }) },
      data: { passwordHash },
    });
    if (updated.count === 0) return null;
    const now = new Date();
    await tx.refreshToken.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: now } });
    await tx.verificationToken.updateMany({ where: { userId, purpose: 'RESET', consumedAt: null }, data: { consumedAt: now } });
    const refreshToken = issueSession ? (await issueRefreshToken(tx, userId)).token : null;
    await beforeCommit?.(tx);
    return { refreshToken };
  });
}

const COOKIE = 'qa_refresh';

const signupSchema = z.object({ email: z.string().email().max(200), password: z.string().min(12).max(200), name: z.string().min(1).max(100) });
const loginSchema = z.object({ email: z.string().email(), password: z.string() });
const confirmSchema = z.object({ token: z.string().min(1).max(200) });
const emailSchema = z.object({ email: z.string().email().max(200) });
const resetSchema = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(12).max(200),
});
// zod strips unknown keys, so `{ name, email, isPlatformAdmin }` only ever
// updates the name.
const nameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
});

const meSelect = { id: true, email: true, name: true, isPlatformAdmin: true, emailVerifiedAt: true } as const;

// Memoised dummy hash used to equalise login timing between "unknown email"
// and "wrong password" — both must pay the same argon2id cost, or repeated
// sampling of response latency reveals which accounts exist. Computed lazily
// (not hard-coded) so it always reflects hashPassword's current parameters;
// do not replace this with a precomputed literal or skip calling it.
let dummyHash: string | null = null;
const getDummyHash = async () => (dummyHash ??= await hashPassword('dummy-password-for-timing-equalisation'));

/**
 * @internal Test seams. Each runs after a password has been verified and
 * before anything is written on the strength of it.
 */
export interface AuthRouteHooks {
  afterLoginVerify?: () => Promise<void>;
  afterPasswordVerify?: () => Promise<void>;
  /** Last thing inside the password change's transaction, with the User lock held. */
  beforePasswordCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Right after the password change's transaction has committed. */
  afterPasswordCommit?: () => Promise<void>;
}

export async function authRoutes(app: FastifyInstance, opts: { hooks?: AuthRouteHooks } = {}): Promise<void> {
  const hooks = opts.hooks ?? {};
  const setRefresh = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/v1/auth', secure: app.config.NODE_ENV === 'production',
      maxAge: Math.floor(REFRESH_TTL_MS / 1000),
    });

  const issue = async (reply: FastifyReply, userId: string) => {
    const accessToken = await reply.jwtSign({ sub: userId });
    const { token } = await issueRefreshToken(app.prisma, userId);
    setRefresh(reply, token);
    return accessToken;
  };

  const link = (path: string, token: string) => {
    const url = new URL(path, app.config.WEB_ORIGIN);
    url.searchParams.set('token', token);
    return url.toString();
  };
  const verifyMail = (to: string, token: string) =>
    ({ to, ...verifyEmail({ href: link('/verify', token), email: to, ttlMs: VERIFY_TTL_MS }) });
  const resetMail = (to: string, token: string) =>
    ({ to, ...resetPasswordEmail({ href: link('/reset-password', token), email: to, ttlMs: RESET_TTL_MS }) });

  // The limiter keys on IP only, so a shared egress address (an office, a
  // university, CGNAT) must not get locked out by a normal team signing up
  // together — 10/minute was tight enough to do that. 30/minute still
  // blocks a scripted signup-spam run while giving real teams headroom.
  app.post('/v1/auth/signup', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const { email, password, name } = parsed.data;

    const exists = await app.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (exists) return reply.code(409).send({ error: 'email already registered' });

    const user = await app.prisma.user.create({
      data: { email: email.toLowerCase(), name, passwordHash: await hashPassword(password) },
      select: { id: true, email: true, name: true, isPlatformAdmin: true },
    });
    const accessToken = await issue(reply, user.id);

    // A mail failure must never fail signup, and the user can always resend
    // via /v1/auth/verify/request. `mailer.send` itself never throws, but the
    // token issuance is a DB write and is wrapped defensively all the same.
    try {
      const { token } = await issueVerificationToken(app.prisma, user.id, 'VERIFY');
      await app.mailer.send(verifyMail(email.toLowerCase(), token));
    } catch (err) {
      req.log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'verification mail failed');
    }

    return reply.code(201).send({ accessToken, user });
  });

  app.post('/v1/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const user = await app.prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
    // Constant-shape AND constant-time response whether the email exists or
    // not: always run argon2id against a real hash (the user's, or a dummy
    // one) so an unknown email can't be distinguished from a wrong password
    // by response latency.
    const hash = user?.passwordHash ?? (await getDummyHash());
    const ok = await verifyPassword(hash, parsed.data.password);
    if (!user || !ok) return reply.code(401).send({ error: 'invalid credentials' });
    await hooks.afterLoginVerify?.();
    // Compare-and-swap against a password change: issue the refresh token
    // under the User lock, and only if the hash is still the one just
    // verified. Otherwise a login with the old password, racing the change,
    // would mint a session after the change revoked them all.
    const refresh = await app.prisma.$transaction(async (tx) => {
      await lockUser(tx, user.id);
      const current = await tx.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
      if (current?.passwordHash !== user.passwordHash) return null;
      return issueRefreshToken(tx, user.id);
    });
    if (!refresh) return reply.code(401).send({ error: 'invalid credentials' });
    setRefresh(reply, refresh.token);
    const accessToken = await reply.jwtSign({ sub: user.id });
    return reply.send({ accessToken, user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin } });
  });

  app.post('/v1/auth/refresh', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (!token) return reply.code(401).send({ error: 'no refresh token' });
    const result = await rotateRefreshToken(app.prisma, token);
    if (result === 'invalid' || result === 'reused') {
      reply.clearCookie(COOKIE, { path: '/v1/auth' });
      return reply.code(401).send({ error: 'invalid refresh token' });
    }
    setRefresh(reply, result.token);
    const accessToken = await reply.jwtSign({ sub: result.userId });
    return reply.send({ accessToken });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await consumeRefreshToken(app.prisma, token);
    reply.clearCookie(COOKIE, { path: '/v1/auth' });
    return reply.code(204).send();
  });

  app.get('/v1/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = await app.prisma.user.findUnique({ where: { id: req.user.id }, select: meSelect });
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return user;
  });

  app.patch('/v1/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = nameSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const updated = await app.prisma.user.updateMany({ where: { id: req.user.id }, data: { name: parsed.data.name } });
    if (updated.count === 0) return reply.code(401).send({ error: 'unauthorized' });
    return app.prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: meSelect });
  });

  app.post(
    '/v1/me/password',
    { preHandler: [app.authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
      const { currentPassword, newPassword } = parsed.data;
      // Checked before argon2: costs nothing, and says nothing about whether
      // currentPassword is right.
      if (newPassword === currentPassword) {
        return reply.code(400).send({ error: 'new password must differ from the current one' });
      }

      // A missing row means a deleted account holding a still-valid access
      // token: treat it as signed out, as GET /v1/me does. Nothing to
      // enumerate here, since the caller already proved who they were.
      const user = await app.prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      // argon2.verify compares in constant time.
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        return reply.code(403).send({ error: 'wrong-password' });
      }
      await hooks.afterPasswordVerify?.();

      // Compare-and-swap on the hash just verified: a concurrent change that
      // committed first wins, and this one writes, revokes and issues nothing.
      const changed = await replacePassword(app.prisma, user.id, await hashPassword(newPassword), {
        expectedHash: user.passwordHash,
        issueSession: true,
        beforeCommit: hooks.beforePasswordCommit,
      });
      if (!changed?.refreshToken) return reply.code(409).send({ error: 'password-changed' });
      await hooks.afterPasswordCommit?.();

      setRefresh(reply, changed.refreshToken);
      const accessToken = await reply.jwtSign({ sub: user.id });
      return reply.send({ accessToken, user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin } });
    },
  );

  app.post(
    '/v1/auth/verify/request',
    { preHandler: [app.authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, email: true, emailVerifiedAt: true },
      });
      if (!user) return reply.code(404).send({ error: 'Not Found' });
      if (user.emailVerifiedAt) return reply.code(202).send({ status: 'already verified' });

      const { token } = await issueVerificationToken(app.prisma, user.id, 'VERIFY');
      await app.mailer.send(verifyMail(user.email, token));
      return reply.code(202).send({ status: 'sent' });
    },
  );

  app.post('/v1/auth/verify/confirm', async (req, reply) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

    const userId = await consumeVerificationToken(app.prisma, parsed.data.token, 'VERIFY');
    if (!userId) return reply.code(400).send({ error: 'invalid or expired token' });

    await app.prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    return reply.send({ status: 'verified' });
  });

  app.post(
    '/v1/auth/password/request',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = emailSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
      const email = parsed.data.email.toLowerCase();

      // Reply FIRST, then do the work. An awaited lookup-and-send would make
      // response latency reveal whether the account exists, which is the same
      // oracle the identical body is written to avoid.
      void reply.code(202).send({ status: 'sent' });

      // Everything below runs after the reply has already been flushed, so a
      // thrown error here can no longer change what the client saw — it can
      // only be logged. Both Prisma calls can throw (a transient DB failure),
      // so this is wrapped the same way the signup resend is, to make sure a
      // failure here is visible in the logs rather than silently swallowed.
      try {
        // Unreachable from the client's perspective: the reply above has
        // already gone out, so this branch only ever short-circuits the rest
        // of *this* function's work (skipping the issue+send for an unknown
        // email) — it can never surface as a different response.
        const user = await app.prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
        if (!user) return;

        const { token } = await issueVerificationToken(app.prisma, user.id, 'RESET');
        await app.mailer.send(resetMail(user.email, token));
      } catch (err) {
        req.log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'password reset mail failed');
      }
    },
  );

  app.post('/v1/auth/password/confirm', async (req, reply) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

    const userId = await consumeVerificationToken(app.prisma, parsed.data.token, 'RESET');
    if (!userId) return reply.code(400).send({ error: 'invalid or expired token' });

    // A password change invalidates every session and every other reset link.
    // The API already revokes a refresh family on replay; resetting after a
    // compromise should do at least as much.
    await replacePassword(app.prisma, userId, await hashPassword(parsed.data.password));

    return reply.send({ status: 'reset' });
  });
}
