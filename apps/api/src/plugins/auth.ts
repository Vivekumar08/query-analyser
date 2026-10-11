import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export default fp(async function authPlugin(app: FastifyInstance) {
  await app.register(import('@fastify/cookie'), { secret: app.config.COOKIE_SECRET });
  await app.register(import('@fastify/jwt'), { secret: app.config.JWT_SECRET, sign: { expiresIn: '15m' } });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await req.jwtVerify<{ sub: string }>();
      req.user = { id: payload.sub };
    } catch {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  /**
   * Blocks an unverified account.
   *
   * Deliberately NOT applied to:
   *  - `/v1/auth/*` and `/v1/me` — an unverified user must be able to log in,
   *    refresh, and request or confirm verification. Gating these locks everyone
   *    out of the only path that would unblock them.
   *  - `/v1/ingest` — authenticated by an app's ingest key, not by a user. A
   *    customer's data must keep flowing regardless of any human's email state.
   */
  app.decorate('requireVerified', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await app.prisma.user.findUnique({
      where: { id: req.user.id },
      select: { emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt) {
      await reply.code(403).send({ error: 'email not verified', code: 'email_not_verified' });
    }
  });

  app.decorate('requirePlatformAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    // Verify the JWT here rather than delegating to `authenticate`: Fastify 5
    // has no reliable "was a reply already sent" flag to branch on afterwards.
    let userId: string;
    try {
      userId = (await req.jwtVerify<{ sub: string }>()).sub;
    } catch {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    req.user = { id: userId };
    const u = await app.prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
    if (!u?.isPlatformAdmin) {
      await reply.code(404).send({ error: 'Not Found' });
      return;
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireVerified: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePlatformAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: { id: string };
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { sub: string }; user: { id: string } }
}
