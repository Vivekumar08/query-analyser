import type { PrismaClient } from '../db.js';

/**
 * Recomputes one whole day from the hourly rollups that still exist and
 * OVERWRITES the daily row.
 *
 * This deliberately does not accumulate. `DO UPDATE SET count = count +
 * EXCLUDED.count` reads naturally and doubles a day's numbers the first time
 * the nightly job runs twice — a retry, a restart mid-run, a manual trigger.
 * Replace semantics make a re-run a no-op.
 *
 * `hist` is summed element-wise across every hour of the day. `unnest ...
 * WITH ORDINALITY` keeps each bucket's index, and `ORDER BY i` in the
 * re-aggregation makes the output order deterministic rather than relying on
 * the planner — the same property Task 4 of the api-foundation plan proved for
 * the pairwise `unnest` in ingest/writer.ts.
 *
 * @param day midnight UTC of the day to compact
 * @returns the number of daily rows written
 */
export async function compactDay(prisma: PrismaClient, day: Date): Promise<number> {
  return prisma.$executeRaw`
    WITH exploded AS (
      SELECT r."signatureId", u.i, u.v, r."count", r."totalMs", r."maxMs", r.id
      FROM "QueryRollup" r,
           unnest(r.hist) WITH ORDINALITY AS u(v, i)
      WHERE r."bucketHour" >= ${day}
        AND r."bucketHour" <  ${day}::timestamptz + interval '1 day'
    ),
    hists AS (
      SELECT "signatureId", array_agg(s ORDER BY i) AS hist
      FROM (
        SELECT "signatureId", i, sum(v)::int AS s
        FROM exploded
        GROUP BY "signatureId", i
      ) q
      GROUP BY "signatureId"
    ),
    totals AS (
      SELECT r."signatureId",
             sum(r."count")::int    AS count,
             sum(r."totalMs")       AS "totalMs",
             max(r."maxMs")::int    AS "maxMs"
      FROM "QueryRollup" r
      WHERE r."bucketHour" >= ${day}
        AND r."bucketHour" <  ${day}::timestamptz + interval '1 day'
      GROUP BY r."signatureId"
    )
    INSERT INTO "QueryDailyRollup" ("id","signatureId","day","count","totalMs","maxMs","hist")
    SELECT gen_random_uuid(), t."signatureId", ${day}, t.count, t."totalMs", t."maxMs", h.hist
    FROM totals t
    JOIN hists h ON h."signatureId" = t."signatureId"
    ON CONFLICT ("signatureId","day") DO UPDATE SET
      "count"   = EXCLUDED."count",
      "totalMs" = EXCLUDED."totalMs",
      "maxMs"   = EXCLUDED."maxMs",
      "hist"    = EXCLUDED."hist"
  `;
}

/** Deletes hourly rollups strictly older than `before`. Retention: 7 days. */
export async function pruneHourly(prisma: PrismaClient, before: Date): Promise<number> {
  const r = await prisma.queryRollup.deleteMany({ where: { bucketHour: { lt: before } } });
  return r.count;
}

/** Deletes daily rollups strictly older than `before`. Retention: 90 days. */
export async function pruneDaily(prisma: PrismaClient, before: Date): Promise<number> {
  const r = await prisma.queryDailyRollup.deleteMany({ where: { day: { lt: before } } });
  return r.count;
}
