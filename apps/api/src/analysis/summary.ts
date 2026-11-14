import type { PrismaClient } from '../db.js';
import { percentilesFor, isSqlSource, avgMs } from './percentile.js';
import type { PercentileResult } from './percentile.js';

export interface SourceSummary {
  /** 'postgresql' | 'mongodb' | future values. */
  source: string;
  /**
   * What `count` counts. MongoDB records only slow queries (at or above the
   * app's `thresholdMs`); SQL sources record every statement. The two are
   * different quantities and are never added together.
   */
  counts: 'all-statements' | 'slow-only';
  count: number;
  totalMs: bigint;
  avgMs: number;
  maxMs: number;
  /** SQL: null unless the window's fine histogram is complete. Mongo: always set. */
  p50: PercentileResult | null;
  p95: PercentileResult | null;
  p99: PercentileResult | null;
  /** Statements at or above the threshold (the sum of the coarse histogram). Equals `count` for MongoDB. */
  slowCount: number;
  errors: number;
  /** True when any rollup in the window sampled its under-threshold statements. */
  sampled: boolean;
  sampleRate: number | null;
}

export interface SummaryResponse {
  grain: 'hourly' | 'daily';
  from: string;
  to: string;
  /** The app's slow threshold; Mongo figures are slow queries at or above it. null = SDK default. */
  thresholdMs: number | null;
  /**
   * Shape records the quota rejected in the window, summed over batches.
   * A shape that is rejected again in a later batch counts again, so this is a
   * volume of rejected records, NOT a count of distinct shapes.
   */
  droppedNew: number;
  /** One entry per source, never combined: postgresql, mongodb, then others alphabetically. */
  sources: SourceSummary[];
}

interface Row {
  source: string;
  count: bigint;
  totalMs: bigint;
  maxMs: number;
  errors: bigint;
  minSampleRate: number | null;
  hist: bigint[] | null;
  histFine: bigint[] | null;
}

const HIST_LENGTH = 8;
const rank = (s: string) => (s === 'postgresql' ? 0 : s === 'mongodb' ? 1 : 2);

type Window = { from: Date; to: Date; grain: 'hourly' | 'daily' };
type Filter = { source: string | null; orm: string | null };

/**
 * One statement per grain. The CTE `r` holds the window's rollups for the
 * app, so every figure below is scoped by `appId` through the join. A source
 * is `COALESCE(s.source, 'mongodb')`: pre-SQL signatures have a NULL source.
 */
function query(prisma: PrismaClient, appId: string, w: Window, f: Filter): Promise<Row[]> {
  const hourly = w.grain === 'hourly';
  return hourly
    ? prisma.$queryRaw<Row[]>`
      WITH r AS (
        SELECT COALESCE(s.source, 'mongodb') AS source, x."count", x."totalMs", x."maxMs", x.errors,
               x."minSampleRate", x.hist, x."histFine"
        FROM "QuerySignature" s JOIN "QueryRollup" x ON x."signatureId" = s.id
        WHERE s."appId" = ${appId} AND x."bucketHour" BETWEEN ${w.from} AND ${w.to}
          AND (${f.source}::text IS NULL OR COALESCE(s.source, 'mongodb') = ${f.source})
          AND (${f.orm}::text IS NULL OR s.orm = ${f.orm})
      ), base AS (
        SELECT source, SUM("count")::bigint AS count, SUM("totalMs")::bigint AS "totalMs",
               MAX("maxMs")::int AS "maxMs", SUM(errors)::bigint AS errors, MIN("minSampleRate") AS "minSampleRate"
        FROM r GROUP BY source
      ), h AS (
        SELECT source, ARRAY_AGG(v ORDER BY idx) AS hist FROM (
          SELECT source, idx, SUM(u.h)::bigint AS v FROM r, unnest(r.hist) WITH ORDINALITY AS u(h, idx) GROUP BY source, idx
        ) t GROUP BY source
      ), hf AS (
        SELECT source, ARRAY_AGG(v ORDER BY idx) AS "histFine" FROM (
          SELECT source, idx, SUM(u.h)::bigint AS v FROM r, unnest(r."histFine") WITH ORDINALITY AS u(h, idx)
          -- Defensive: the table CHECK allows only 0 or 14 entries, but a stray length would misalign the buckets.
          WHERE cardinality(r."histFine") = 14 GROUP BY source, idx
        ) t GROUP BY source
      )
      SELECT b.*, h.hist, hf."histFine" FROM base b
      LEFT JOIN h ON h.source = b.source LEFT JOIN hf ON hf.source = b.source`
    : prisma.$queryRaw<Row[]>`
      WITH r AS (
        SELECT COALESCE(s.source, 'mongodb') AS source, x."count", x."totalMs", x."maxMs", x.errors,
               x."minSampleRate", x.hist, x."histFine"
        FROM "QuerySignature" s JOIN "QueryDailyRollup" x ON x."signatureId" = s.id
        WHERE s."appId" = ${appId} AND x.day BETWEEN ${w.from} AND ${w.to}
          AND (${f.source}::text IS NULL OR COALESCE(s.source, 'mongodb') = ${f.source})
          AND (${f.orm}::text IS NULL OR s.orm = ${f.orm})
      ), base AS (
        SELECT source, SUM("count")::bigint AS count, SUM("totalMs")::bigint AS "totalMs",
               MAX("maxMs")::int AS "maxMs", SUM(errors)::bigint AS errors, MIN("minSampleRate") AS "minSampleRate"
        FROM r GROUP BY source
      ), h AS (
        SELECT source, ARRAY_AGG(v ORDER BY idx) AS hist FROM (
          SELECT source, idx, SUM(u.h)::bigint AS v FROM r, unnest(r.hist) WITH ORDINALITY AS u(h, idx) GROUP BY source, idx
        ) t GROUP BY source
      ), hf AS (
        SELECT source, ARRAY_AGG(v ORDER BY idx) AS "histFine" FROM (
          SELECT source, idx, SUM(u.h)::bigint AS v FROM r, unnest(r."histFine") WITH ORDINALITY AS u(h, idx)
          -- Defensive: the table CHECK allows only 0 or 14 entries, but a stray length would misalign the buckets.
          WHERE cardinality(r."histFine") = 14 GROUP BY source, idx
        ) t GROUP BY source
      )
      SELECT b.*, h.hist, hf."histFine" FROM base b
      LEFT JOIN h ON h.source = b.source LEFT JOIN hf ON hf.source = b.source`;
}

export async function summarise(
  prisma: PrismaClient,
  appId: string,
  w: Window,
  f: Filter,
): Promise<Omit<SummaryResponse, 'grain' | 'from' | 'to'>> {
  const [rows, drops, owner] = await Promise.all([
    query(prisma, appId, w, f),
    prisma.quotaDrop.aggregate({
      where: { appId, bucketHour: { gte: w.from, lte: w.to } },
      _sum: { droppedNew: true },
    }),
    prisma.app.findUnique({ where: { id: appId }, select: { thresholdMs: true } }),
  ]);

  const sources = rows
    .map((r): SourceSummary => {
      const count = Number(r.count);
      const hist = Array.from({ length: HIST_LENGTH }, (_, i) => Number(r.hist?.[i] ?? 0));
      const histFine = r.histFine ? r.histFine.map(Number) : null;
      const sql = isSqlSource(r.source);
      const pct = percentilesFor(sql, hist, histFine, count, r.maxMs);
      return {
        source: r.source,
        counts: sql ? 'all-statements' : 'slow-only',
        count,
        totalMs: r.totalMs,
        avgMs: avgMs(r.totalMs, count),
        maxMs: r.maxMs,
        ...pct,
        slowCount: hist.reduce((a, b) => a + b, 0),
        errors: Number(r.errors),
        sampled: r.minSampleRate !== null,
        sampleRate: r.minSampleRate,
      };
    })
    .sort((a, b) => rank(a.source) - rank(b.source) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  return { thresholdMs: owner?.thresholdMs ?? null, droppedNew: drops._sum.droppedNew ?? 0, sources };
}
