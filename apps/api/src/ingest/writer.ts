import type { PrismaClient } from '../db.js';
import type { IngestPayload } from '@query-analyser/contract';

export function bucketToDate(bucket: string): Date {
  const y = Number(bucket.slice(0, 4));
  const m = Number(bucket.slice(4, 6)) - 1;
  const d = Number(bucket.slice(6, 8));
  const h = Number(bucket.slice(8, 10));
  return new Date(Date.UTC(y, m, d, h));
}

/**
 * Two statements per batch:
 *  1. upsert signatures by (appId, hash), returning ids
 *  2. upsert rollups by (signatureId, bucketHour) with accumulate semantics
 * Both use jsonb_to_recordset so a batch of any size is one round-trip each.
 *
 * Accumulate semantics mirror the SDK's own in-process merge(): count and
 * totalMs add, maxMs takes the greater value, hist adds element-wise. This
 * lets concurrently-arriving batches for the same signature/hour combine
 * correctly without any application-level locking — the single UPDATE
 * statement (via ON CONFLICT DO UPDATE) is atomic per row in PostgreSQL.
 */
export async function writeBatch(
  prisma: PrismaClient,
  appId: string,
  payload: IngestPayload,
): Promise<{ signatures: number; rollups: number }> {
  if (payload.items.length === 0) return { signatures: 0, rollups: 0 };

  const now = new Date();
  const bucketHour = bucketToDate(payload.bucket);

  // Dedupe by hash within the batch (the SDK already does, but be safe).
  const byHash = new Map(payload.items.map((i) => [i.hash, i]));
  const items = [...byHash.values()];

  const sigRows = items.map((i) => ({
    appId,
    hash: i.hash,
    signature: i.signature,
    model: i.model,
    operation: i.operation,
    filterShape: i.filterShape,
    sortKeys: i.sortKeys,
    stages: i.stages,
    redactedSample: i.sample ?? null,
  }));

  const ids = await prisma.$queryRaw<{ id: string; hash: string }[]>`
    INSERT INTO "QuerySignature" ("id","appId","hash","signature","model","operation","filterShape","sortKeys","stages","redactedSample","firstSeen","lastSeen")
    SELECT gen_random_uuid(), t."appId", t.hash, t.signature, t.model, t.operation, t."filterShape", t."sortKeys", t.stages, t."redactedSample", ${now}, ${now}
    FROM jsonb_to_recordset(${JSON.stringify(sigRows)}::jsonb)
      AS t("appId" uuid, hash text, signature text, model text, operation text, "filterShape" jsonb, "sortKeys" jsonb, stages text[], "redactedSample" jsonb)
    ON CONFLICT ("appId","hash") DO UPDATE SET
      "lastSeen" = EXCLUDED."lastSeen",
      "redactedSample" = COALESCE(EXCLUDED."redactedSample", "QuerySignature"."redactedSample")
    RETURNING id, hash
  `;

  const idByHash = new Map(ids.map((r) => [r.hash, r.id]));

  const rollRows = items.map((i) => ({
    signatureId: idByHash.get(i.hash)!,
    bucketHour: bucketHour.toISOString(),
    count: i.count,
    totalMs: Math.round(i.totalMs),
    maxMs: Math.round(i.maxMs),
    hist: `{${i.hist.join(',')}}`,
  }));

  const rollups = await prisma.$executeRaw`
    INSERT INTO "QueryRollup" ("id","signatureId","bucketHour","count","totalMs","maxMs","hist")
    SELECT gen_random_uuid(), t."signatureId", t."bucketHour", t.count, t."totalMs", t."maxMs", t.hist::int[]
    FROM jsonb_to_recordset(${JSON.stringify(rollRows)}::jsonb)
      AS t("signatureId" uuid, "bucketHour" timestamptz, count int, "totalMs" bigint, "maxMs" int, hist text)
    ON CONFLICT ("signatureId","bucketHour") DO UPDATE SET
      "count"   = "QueryRollup"."count"   + EXCLUDED."count",
      "totalMs" = "QueryRollup"."totalMs" + EXCLUDED."totalMs",
      "maxMs"   = GREATEST("QueryRollup"."maxMs", EXCLUDED."maxMs"),
      "hist"    = ARRAY(SELECT a + b FROM unnest("QueryRollup"."hist", EXCLUDED."hist"::int[]) AS u(a, b))
  `;

  return { signatures: ids.length, rollups };
}
