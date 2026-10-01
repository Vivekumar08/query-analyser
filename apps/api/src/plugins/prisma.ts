import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createPrisma, type PrismaClient } from '../db.js';
import { KeyResolver } from '../ingest/keys.js';

export default fp(async function prismaPlugin(app: FastifyInstance) {
  const prisma = createPrisma(app.config.DATABASE_URL);
  app.decorate('prisma', prisma);
  app.decorate('keys', new KeyResolver(prisma));
  app.decorate('ingestStats', { batches: 0, accepted: 0, rejected401: 0, rejected400: 0, rejected429: 0, since: new Date().toISOString() });
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});

export interface IngestStats {
  batches: number;
  accepted: number;
  rejected401: number;
  rejected400: number;
  rejected429: number;
  since: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    keys: KeyResolver;
    ingestStats: IngestStats;
  }
}
