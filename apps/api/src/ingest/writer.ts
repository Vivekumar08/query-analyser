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
 * Three statements per batch:
 *  1. record the SDK's thresholdMs on the app when it changed
 *  2. upsert signatures by (appId, hash), returning ids
 *  3. upsert rollups by (signatureId, bucketHour) with accumulate semantics
 * The two upserts use jsonb_to_recordset so a batch of any size is one round-trip each.
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

  // Last payload wins; skipped when unchanged so a steady app writes nothing.
  // Runs first: it is the one statement a payload value can make fail, and
  // nothing may be counted before it. A batch that fails after its rollups
  // committed would be re-counted when the SDK retries it.
  await prisma.$executeRaw`
    UPDATE "App" SET "thresholdMs" = ${payload.thresholdMs}::int
    WHERE id = ${appId} AND "thresholdMs" IS DISTINCT FROM ${payload.thresholdMs}::int
  `;

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
    encryptedSample: i.encryptedSample ?? null,
    source: i.source ?? null,
    collection: i.collection ?? null,
    orm: i.orm ?? null,
    database: i.database ?? null,
    sqlText: i.sql ?? null,
    lastErrorCode: i.errorCodes?.[0]?.code ?? null,
  }));

  // `encryptedSample` is kept only while the app has a sample key: an app
  // that never opted in stores nothing new, whatever a client sends. The
  // check is part of the same statement, so no extra round-trip. Like
  // `redactedSample`, a null never overwrites a stored envelope, which also
  // makes a flush split across several requests (SDK chunking) safe.
  const ids = await prisma.$queryRaw<{ id: string; hash: string }[]>`
    WITH k AS (SELECT ("samplePublicKey" IS NOT NULL) AS keyed FROM "App" WHERE id = ${appId})
    INSERT INTO "QuerySignature" ("id","appId","hash","signature","model","operation","filterShape","sortKeys","stages","redactedSample","encryptedSample","source","collection","orm","database","sqlText","lastErrorCode","firstSeen","lastSeen")
    SELECT gen_random_uuid(), t."appId", t.hash, t.signature, t.model, t.operation, t."filterShape", t."sortKeys", t.stages, t."redactedSample",
      CASE WHEN (SELECT keyed FROM k) THEN t."encryptedSample" END, t.source, t.collection, t.orm, t.database, t."sqlText", t."lastErrorCode", ${now}, ${now}
    FROM jsonb_to_recordset(${JSON.stringify(sigRows)}::jsonb)
      AS t("appId" uuid, hash text, signature text, model text, operation text, "filterShape" jsonb, "sortKeys" jsonb, stages text[], "redactedSample" jsonb, "encryptedSample" jsonb, source text, collection text, orm text, database text, "sqlText" text, "lastErrorCode" text)
    ON CONFLICT ("appId","hash") DO UPDATE SET
      "lastSeen" = EXCLUDED."lastSeen",
      "redactedSample" = COALESCE(EXCLUDED."redactedSample", "QuerySignature"."redactedSample"),
      "encryptedSample" = COALESCE(EXCLUDED."encryptedSample", "QuerySignature"."encryptedSample"),
      "source" = COALESCE("QuerySignature"."source", EXCLUDED."source"),
      "collection" = COALESCE("QuerySignature"."collection", EXCLUDED."collection"),
      "orm" = CASE WHEN "QuerySignature"."orm" IS NULL AND EXCLUDED."orm" IS NOT NULL THEN EXCLUDED."orm" ELSE "QuerySignature"."orm" END,
      "model" = CASE WHEN "QuerySignature"."orm" IS NULL AND EXCLUDED."orm" IS NOT NULL THEN EXCLUDED."model" ELSE "QuerySignature"."model" END,
      "operation" = CASE WHEN "QuerySignature"."orm" IS NULL AND EXCLUDED."orm" IS NOT NULL THEN EXCLUDED."operation" ELSE "QuerySignature"."operation" END,
      "database" = COALESCE("QuerySignature"."database", EXCLUDED."database"),
      "sqlText" = COALESCE("QuerySignature"."sqlText", EXCLUDED."sqlText"),
      "lastErrorCode" = COALESCE(EXCLUDED."lastErrorCode", "QuerySignature"."lastErrorCode")
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
    errors: i.errors ?? 0,
    histFine: i.histFine ? `{${i.histFine.join(',')}}` : '{}',
    minSampleRate: i.sampleRate ?? null,
  }));

  const rollups = await prisma.$executeRaw`
    INSERT INTO "QueryRollup" ("id","signatureId","bucketHour","count","totalMs","maxMs","hist","errors","histFine","minSampleRate")
    SELECT gen_random_uuid(), t."signatureId", t."bucketHour", t.count, t."totalMs", t."maxMs", t.hist::int[], t.errors, t."histFine"::int[], t."minSampleRate"
    FROM jsonb_to_recordset(${JSON.stringify(rollRows)}::jsonb)
      AS t("signatureId" uuid, "bucketHour" timestamptz, count int, "totalMs" bigint, "maxMs" int, hist text, errors int, "histFine" text, "minSampleRate" float8)
    ON CONFLICT ("signatureId","bucketHour") DO UPDATE SET
      "count"   = "QueryRollup"."count"   + EXCLUDED."count",
      "totalMs" = "QueryRollup"."totalMs" + EXCLUDED."totalMs",
      "maxMs"   = GREATEST("QueryRollup"."maxMs", EXCLUDED."maxMs"),
      "hist"    = ARRAY(SELECT a + b FROM unnest("QueryRollup"."hist", EXCLUDED."hist"::int[]) AS u(a, b)),
      "errors"  = "QueryRollup"."errors"  + EXCLUDED."errors",
      "histFine" = CASE
        WHEN cardinality("QueryRollup"."histFine") = 0 THEN EXCLUDED."histFine"
        WHEN cardinality(EXCLUDED."histFine") = 0 THEN "QueryRollup"."histFine"
        ELSE ARRAY(SELECT a + b FROM unnest("QueryRollup"."histFine", EXCLUDED."histFine") AS u(a, b))
      END,
      "minSampleRate" = LEAST("QueryRollup"."minSampleRate", EXCLUDED."minSampleRate")
  `;

  return { signatures: ids.length, rollups };
}
