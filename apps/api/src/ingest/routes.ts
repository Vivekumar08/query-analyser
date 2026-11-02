import type { FastifyInstance } from 'fastify';
import { ingestPayloadSchema, type IngestPayload } from '@query-analyser/contract';
import { writeBatch, bucketToDate } from './writer.js';
import { hashKey } from './keys.js';
import { isForeignKeyViolation } from '../db-errors.js';

const SIGNATURE_QUOTA = 5000;
// Tail of each app's in-flight quota check + write.
const quotaLocks = new Map<string, Promise<void>>();
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

  // Count every 429 this route emits (rate-limit only; the quota never 429s). @fastify/rate-limit's own preHandler can reject a request with
  // 429 before the handler below ever runs, so counting only inside the
  // quota branch would under-report during a rate-limit storm — exactly
  // when an operator most needs `rejected429` to be accurate. This hook is
  // scoped to this plugin's encapsulation context, so it only observes
  // responses from the /v1/ingest route declared below.
  app.addHook('onResponse', async (_req, reply) => {
    if (reply.statusCode === 429) app.ingestStats.rejected429 += 1;
  });

  app.post(
    '/v1/ingest',
    {
      bodyLimit: MAX_BODY_BYTES,
      config: { rateLimit: { max: rateLimitMax, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      app.ingestStats.batches += 1;

      const auth = req.headers.authorization ?? '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const resolved = key ? await app.keys.resolve(key) : null;
      if (!resolved) {
        app.ingestStats.rejected401 += 1;
        return reply.code(401).send({ error: 'invalid ingest key' });
      }
      if (resolved.suspended) return reply.code(403).send({ error: 'organization suspended' });

      const parsed = ingestPayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        app.ingestStats.rejected400 += 1;
        return reply.code(400).send({ error: 'invalid payload', issues: parsed.error.issues.slice(0, 20) });
      }
      // zod infers `sample: z.unknown().nullable()` as an *optional* key
      // (unknown structurally includes undefined), while the hand-written
      // `IngestItem.sample` in @query-analyser/contract is required
      // (`unknown | null`). The runtime shapes agree — a parsed item always
      // has the key, possibly `null` — so this is a type-level-only cast.
      const payload = parsed.data as IngestPayload;

      // Quota: only new hashes count toward it. At the quota the batch is
      // not refused: items for known signatures are kept, new ones past the
      // room left are dropped and the drop is recorded. The check and the
      // write run under a per-app lock so two batches racing at the boundary
      // cannot both claim the last slots (in-process; across replicas the
      // overshoot is bounded by one batch per replica).
      const appId = resolved.appId;
      const keyId = resolved.keyId;
      const prev = quotaLocks.get(appId) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => { release = r; });
      const tail = prev.then(() => mine);
      quotaLocks.set(appId, tail);
      await prev;
      try {
        return await handleBatch();
      } finally {
        release();
        if (quotaLocks.get(appId) === tail) quotaLocks.delete(appId);
      }

      async function handleBatch() {
      const dropped = new Set<string>();
      const hashes = [...new Set(payload.items.map((i) => i.hash))];
      if (hashes.length > 0) {
        const knownRows = await app.prisma.querySignature.findMany({
          where: { appId, hash: { in: hashes } },
          select: { hash: true },
        });
        const known = new Set(knownRows.map((r) => r.hash));
        const fresh = hashes.filter((h) => !known.has(h));
        if (fresh.length > 0) {
          const existing = await app.prisma.querySignature.count({ where: { appId } });
          const room = Math.max(0, SIGNATURE_QUOTA - existing);
          for (const h of fresh.slice(room)) dropped.add(h);
        }
      }
      if (dropped.size > 0) {
        payload.items = payload.items.filter((i) => !dropped.has(i.hash));
      }

      // A malformed payload should never reach writeBatch (zod already
      // rejects it above), but if the database still raises — e.g. the
      // `hist` length CHECK constraint on QueryRollup — never let the raw
      // Postgres error text (which names the constraint/table/relation)
      // reach the client. Log it server-side and return a clean 500.
      let signatures: number;
      try {
        ({ signatures } = await writeBatch(app.prisma, appId, payload));
      } catch (err) {
        // A key cached (here, for up to 60s) for an app deleted since: on
        // another replica, or by a delete that committed after this request
        // resolved its key. Either of writeBatch's statements then fails on
        // its foreign key. If the app really is gone, the key is dead: evict
        // it and refuse it like any unknown key, rather than 500 until the
        // cache entry expires.
        if (isForeignKeyViolation(err) && !(await app.prisma.app.findUnique({ where: { id: appId }, select: { id: true } }))) {
          app.keys.invalidate(hashKey(key));
          app.ingestStats.rejected401 += 1;
          return reply.code(401).send({ error: 'invalid ingest key' });
        }
        req.log.error({ err }, 'writeBatch failed');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }

      // Fire-and-forget: never make the SDK wait on a bookkeeping write.
      void app.prisma.ingestKey
        .update({ where: { id: keyId }, data: { lastUsedAt: new Date() } })
        .catch((err: unknown) => req.log.warn({ err }, 'lastUsedAt update failed'));

      if (dropped.size > 0) {
        const bucketHour = bucketToDate(payload.bucket);
        try {
          await app.prisma.$executeRaw`
            INSERT INTO "QuotaDrop" ("appId", "bucketHour", "droppedNew")
            VALUES (${appId}, ${bucketHour}, ${dropped.size})
            ON CONFLICT ("appId", "bucketHour")
            DO UPDATE SET "droppedNew" = "QuotaDrop"."droppedNew" + EXCLUDED."droppedNew"`;
        } catch (err) {
          // Bookkeeping only: the batch itself was stored.
          req.log.warn({ err }, 'QuotaDrop write failed');
        }
        app.ingestStats.droppedNew += dropped.size;
      }

      app.ingestStats.accepted += signatures;
      return reply.code(202).send({ accepted: signatures, droppedNew: dropped.size });
      }
    },
  );
}
