import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { importSamplePublicKey, SampleKeyError, SAMPLE_KEY_DEFAULT_ITERATIONS, type WrappedKey } from '@query-analyser/contract';
import { requireAppRole } from '../orgs/rbac.js';
import { Prisma } from '../generated/prisma/client.js';

const base64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9+/]*={0,2}$/);

// The browser sends only the public key and the passphrase-wrapped private
// key; the server can check shapes and the public key, never the wrap.
// Bounds: a P-256 SPKI is 91 bytes (124 chars); salt 16 bytes, iv 12 bytes;
// a wrapped PKCS8 P-256 key is ~154 bytes (~208 chars).
const putSchema = z.object({
  publicKey: base64(300),
  wrapped: z.object({
    v: z.literal(1),
    salt: base64(64),
    iv: base64(32),
    // Production floor (Ruling C4-2): a client may never store a weaker wrap.
    iterations: z.number().int().min(SAMPLE_KEY_DEFAULT_ITERATIONS).max(10_000_000),
    ciphertext: base64(1024),
  }),
});

export async function sampleKeyRoutes(app: FastifyInstance): Promise<void> {
  const auth = (role: 'VIEWER' | 'ADMIN') => ({ preHandler: [app.authenticate, app.requireVerified, requireAppRole(role)] });

  app.get('/v1/apps/:id/sample-key', auth('VIEWER'), async (req) => {
    const a = await app.prisma.app.findUniqueOrThrow({
      where: { id: req.appId },
      select: { samplePublicKey: true, sampleKeyWrapped: true },
    });
    if (!a.samplePublicKey) return { enabled: false };
    return { enabled: true, publicKey: a.samplePublicKey, wrapped: a.sampleKeyWrapped as unknown as WrappedKey };
  });

  // Set or rotate. Old ciphertext is unreadable under a new key, so every
  // stored encrypted sample for the app is cleared in the same transaction.
  app.put('/v1/apps/:id/sample-key', auth('ADMIN'), async (req, reply) => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const { publicKey, wrapped } = parsed.data;
    try {
      await importSamplePublicKey(publicKey);
    } catch (err) {
      if (err instanceof SampleKeyError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    await app.prisma.$transaction([
      app.prisma.app.update({ where: { id: req.appId }, data: { samplePublicKey: publicKey, sampleKeyWrapped: wrapped } }),
      app.prisma.querySignature.updateMany({
        where: { appId: req.appId, NOT: { encryptedSample: { equals: Prisma.DbNull } } },
        data: { encryptedSample: Prisma.DbNull },
      }),
    ]);
    return { enabled: true, publicKey };
  });

  app.delete('/v1/apps/:id/sample-key', auth('ADMIN'), async (req, reply) => {
    await app.prisma.$transaction([
      app.prisma.app.update({ where: { id: req.appId }, data: { samplePublicKey: null, sampleKeyWrapped: Prisma.DbNull } }),
      app.prisma.querySignature.updateMany({
        where: { appId: req.appId, NOT: { encryptedSample: { equals: Prisma.DbNull } } },
        data: { encryptedSample: Prisma.DbNull },
      }),
    ]);
    return reply.code(204).send();
  });
}
