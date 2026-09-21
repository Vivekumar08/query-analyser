import type { FastifyInstance } from 'fastify';
import { ingestPayloadSchema, type IngestPayload } from '@query-analyser/contract';
import { writeBatch } from './writer.js';

const SIGNATURE_QUOTA = 5000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// A legitimate SDK instance flushes once per 10s (6 requests/min), so
// 600/min supports ~100 instances sharing one egress IP (e.g. behind a
// corporate NAT or a serverless platform's shared outbound IP) while still
// bounding a single-source flood. The per-app signature quota (below) is
// the control for authenticated abuse; this is only the pre-auth backstop.
const DEFAULT_RATE_LIMIT_MAX = 600;

export interface IngestRoutesOptions {
  rateLimitMax?: number;
}

export async function ingestRoutes(app: FastifyInstance, opts: IngestRoutesOptions = {}): Promise<void> {
  const rateLimitMax = opts.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
  app.post(
    '/v1/ingest',
    {
      bodyLimit: MAX_BODY_BYTES,
      config: { rateLimit: { max: rateLimitMax, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = req.headers.authorization ?? '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const resolved = key ? await app.keys.resolve(key) : null;
      if (!resolved) return reply.code(401).send({ error: 'invalid ingest key' });
      if (resolved.suspended) return reply.code(403).send({ error: 'organization suspended' });

      const parsed = ingestPayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid payload', issues: parsed.error.issues.slice(0, 20) });
      }
      // zod infers `sample: z.unknown().nullable()` as an *optional* key
      // (unknown structurally includes undefined), while the hand-written
      // `IngestItem.sample` in @query-analyser/contract is required
      // (`unknown | null`). The runtime shapes agree — a parsed item always
      // has the key, possibly `null` — so this is a type-level-only cast.
      const payload = parsed.data as IngestPayload;

      // Quota: only new hashes count toward it.
      const hashes = [...new Set(payload.items.map((i) => i.hash))];
      if (hashes.length > 0) {
        const known = await app.prisma.querySignature.count({
          where: { appId: resolved.appId, hash: { in: hashes } },
        });
        const newCount = hashes.length - known;
        if (newCount > 0) {
          const existing = await app.prisma.querySignature.count({ where: { appId: resolved.appId } });
          if (existing + newCount > SIGNATURE_QUOTA) {
            return reply.code(429).send({ error: 'signature quota exceeded', limit: SIGNATURE_QUOTA });
          }
        }
      }

      // A malformed payload should never reach writeBatch (zod already
      // rejects it above), but if the database still raises — e.g. the
      // `hist` length CHECK constraint on QueryRollup — never let the raw
      // Postgres error text (which names the constraint/table/relation)
      // reach the client. Log it server-side and return a clean 500.
      let signatures: number;
      try {
        ({ signatures } = await writeBatch(app.prisma, resolved.appId, payload));
      } catch (err) {
        req.log.error({ err }, 'writeBatch failed');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }

      // Fire-and-forget: never make the SDK wait on a bookkeeping write.
      void app.prisma.ingestKey
        .update({ where: { id: resolved.keyId }, data: { lastUsedAt: new Date() } })
        .catch((err: unknown) => req.log.warn({ err }, 'lastUsedAt update failed'));

      return reply.code(202).send({ accepted: signatures });
    },
  );
}
