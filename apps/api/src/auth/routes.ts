import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './password.js';
import { issueRefreshToken, rotateRefreshToken, consumeRefreshToken, REFRESH_TTL_MS } from './tokens.js';

const COOKIE = 'qa_refresh';

const signupSchema = z.object({ email: z.string().email().max(200), password: z.string().min(12).max(200), name: z.string().min(1).max(100) });
const loginSchema = z.object({ email: z.string().email(), password: z.string() });

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

  app.post('/v1/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
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
    const user = await app.prisma.user.findUnique({
      where: { id: req.user.id }, select: { id: true, email: true, name: true, isPlatformAdmin: true },
    });
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return user;
  });
}
