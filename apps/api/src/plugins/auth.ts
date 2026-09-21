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
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: { id: string };
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { sub: string }; user: { id: string } }
}
