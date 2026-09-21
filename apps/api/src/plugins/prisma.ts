import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createPrisma, type PrismaClient } from '../db.js';
import { KeyResolver } from '../ingest/keys.js';

export default fp(async function prismaPlugin(app: FastifyInstance) {
  const prisma = createPrisma(app.config.DATABASE_URL);
  app.decorate('prisma', prisma);
  app.decorate('keys', new KeyResolver(prisma));
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    keys: KeyResolver;
  }
}
