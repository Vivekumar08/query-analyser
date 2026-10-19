import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './password.js';
import { issueRefreshToken, rotateRefreshToken, consumeRefreshToken, REFRESH_TTL_MS } from './tokens.js';
import { issueVerificationToken, consumeVerificationToken, VERIFY_TTL_MS, RESET_TTL_MS } from './verification.js';
import { verifyEmail, resetPasswordEmail } from '../mail/templates.js';

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

export async function authRoutes(app: FastifyInstance): Promise<void> {
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
    const accessToken = await issue(reply, user.id);
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

      const user = await app.prisma.user.findUnique({ where: { id: req.user.id } });
      // Same response, same argon2 cost, whether the account still exists or
      // not (a deleted user holding a still-valid access token).
      const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), currentPassword);
      if (!user || !ok) return reply.code(403).send({ error: 'wrong-password' });

      // Store the new hash and revoke every refresh token in one transaction:
      // no window where the new password is live but old sessions can still
      // refresh. The fresh session is issued only after this commits, so it is
      // not caught by the revocation.
      const passwordHash = await hashPassword(newPassword);
      await app.prisma.$transaction([
        app.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
        app.prisma.refreshToken.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } }),
      ]);

      const accessToken = await issue(reply, user.id);
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

    await app.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(parsed.data.password) },
    });

    // A password change invalidates every session. The API already revokes a
    // refresh family on replay; resetting after a compromise should do at least
    // as much.
    await app.prisma.refreshToken.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    return reply.send({ status: 'reset' });
  });
}
