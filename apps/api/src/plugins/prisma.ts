import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createPrisma, type PrismaClient } from '../db.js';
import { KeyResolver } from '../ingest/keys.js';

export default fp(async function prismaPlugin(app: FastifyInstance) {
  const prisma = createPrisma(app.config.DATABASE_URL);
  app.decorate('prisma', prisma);
  app.decorate('keys', new KeyResolver(prisma));
  // In-process ingest counters (v1; a later plan may move these to a
  // table). `batches` only increments once a request reaches the ingest
  // handler, so it excludes anything rejected earlier (e.g. the
  // @fastify/rate-limit preHandler's 429s, which still land in
  // `rejected429`); the 403 suspended-org branch and the 500 branch are not
  // counted at all. `batches` therefore does not reconcile against
  // `accepted + rejected401 + rejected400 + rejected429` — that's expected.
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
