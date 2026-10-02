import type { PrismaClient } from '../db.js';
import { compactDay, pruneHourly, pruneDaily } from './compaction.js';
import { detectRegression, type HourPoint } from './regression.js';
import { percentileFromHist } from './percentile.js';
import { adviceFor } from './advice.js';
import type { FilterShapeItem, SortKey } from '@query-analyser/contract/runtime';

const HOURLY_RETENTION_DAYS = 7;
const DAILY_RETENTION_DAYS = 90;
const TRAILING_DAYS = 7;

export interface JobDeps {
  prisma: PrismaClient;
  /** Injectable for tests. Defaults to the wall clock. */
  now?: Date;
}

export interface HourlyResult {
  alertsCreated: number;
}

export interface NightlyResult {
  daysCompacted: number;
  hourlyPruned: number;
  dailyPruned: number;
  adviceWritten: number;
  newExpensive: number;
}

const daysAgo = (from: Date, n: number) => new Date(from.getTime() - n * 86_400_000);
const startOfHour = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()));

/**
 * These two functions take their dependencies as an argument and know nothing
 * about timers, locks or Fastify. Scaling out means writing a BullMQ worker
 * that calls them and deleting the scheduler — the analysis does not change.
 */
export async function runHourlyJobs(deps: JobDeps): Promise<HourlyResult> {
  const now = deps.now ?? new Date();
  const lastComplete = new Date(startOfHour(now).getTime() - 3_600_000);
  const windowStart = daysAgo(lastComplete, TRAILING_DAYS);

  const rollups = await deps.prisma.queryRollup.findMany({
    where: { bucketHour: { gte: windowStart, lte: lastComplete } },
    select: { signatureId: true, bucketHour: true, count: true, maxMs: true, hist: true },
  });

  const bySignature = new Map<string, typeof rollups>();
  for (const r of rollups) {
    const list = bySignature.get(r.signatureId) ?? [];
    list.push(r);
    bySignature.set(r.signatureId, list);
  }

  let alertsCreated = 0;

  for (const [signatureId, rows] of bySignature) {
    const latestRow = rows.find((r) => r.bucketHour.getTime() === lastComplete.getTime());
    if (!latestRow) continue;

    const point = (r: (typeof rows)[number]): HourPoint => ({
      p95: percentileFromHist(r.hist, r.maxMs, 0.95).value,
      count: r.count,
    });

    const trailing = rows.filter((r) => r !== latestRow).map(point);
    const detail = detectRegression(trailing, point(latestRow));
    if (!detail) continue;

    await deps.prisma.alert.create({
      data: { signatureId, kind: detail.kind, details: { ...detail } },
    });
    alertsCreated += 1;
  }

  return { alertsCreated };
}

export async function runNightlyJobs(deps: JobDeps): Promise<NightlyResult> {
  const now = deps.now ?? new Date();

  // Compact every day that still has hourly rows, oldest first.
  const oldest = await deps.prisma.queryRollup.findFirst({
    orderBy: { bucketHour: 'asc' },
    select: { bucketHour: true },
  });

  let daysCompacted = 0;
  if (oldest) {
    const start = new Date(
      Date.UTC(
        oldest.bucketHour.getUTCFullYear(),
        oldest.bucketHour.getUTCMonth(),
        oldest.bucketHour.getUTCDate(),
      ),
    );
    for (let d = start; d < now; d = new Date(d.getTime() + 86_400_000)) {
      await compactDay(deps.prisma, d);
      daysCompacted += 1;
    }
  }

  const adviceWritten = await refreshAdvice(deps.prisma);

  const newExpensive = await detectNewExpensive({ prisma: deps.prisma, now });

  // Pruning runs LAST. Hourly retention is 7 days and the regression baseline
  // is a 7-day median, so pruning before detection would silently shorten
  // every baseline by an hour.
  const hourlyPruned = await pruneHourly(deps.prisma, daysAgo(now, HOURLY_RETENTION_DAYS));
  const dailyPruned = await pruneDaily(deps.prisma, daysAgo(now, DAILY_RETENTION_DAYS));

  return { daysCompacted, hourlyPruned, dailyPruned, adviceWritten, newExpensive };
}

const NEW_SIGNATURE_WINDOW_MS = 24 * 3_600_000;
const TOP_N = 10;

/**
 * A signature first seen in the last 24 hours whose wasted time is already in
 * the app's top ten. A pure-regression rule cannot catch this — a query that
 * has only ever been slow has no baseline to regress from — and a deploy
 * introducing a bad query is the most common real cause.
 */
export async function detectNewExpensive(deps: JobDeps): Promise<number> {
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - NEW_SIGNATURE_WINDOW_MS);

  const rows = await deps.prisma.$queryRaw<{ id: string; appId: string; firstSeen: Date }[]>`
    WITH ranked AS (
      SELECT s.id, s."appId", s."firstSeen",
             row_number() OVER (PARTITION BY s."appId" ORDER BY sum(r."totalMs") DESC) AS rank
      FROM "QuerySignature" s
      JOIN "QueryRollup" r ON r."signatureId" = s.id
      GROUP BY s.id, s."appId", s."firstSeen"
    )
    SELECT id, "appId", "firstSeen" FROM ranked
    WHERE rank <= ${TOP_N} AND "firstSeen" >= ${since}
  `;

  let created = 0;
  for (const row of rows) {
    // One alert per signature per kind — re-alerting every night is how an
    // alert list becomes something nobody reads.
    const existing = await deps.prisma.alert.findFirst({
      where: { signatureId: row.id, kind: 'new_expensive' },
      select: { id: true },
    });
    if (existing) continue;

    await deps.prisma.alert.create({
      data: {
        signatureId: row.id,
        kind: 'new_expensive',
        details: { firstSeen: row.firstSeen.toISOString(), window: '24h', topN: TOP_N },
      },
    });
    created += 1;
  }
  return created;
}

async function refreshAdvice(prisma: PrismaClient): Promise<number> {
  const signatures = await prisma.querySignature.findMany({
    select: { id: true, filterShape: true, sortKeys: true, advice: { select: { status: true } } },
  });

  let written = 0;
  for (const s of signatures) {
    // A dismissed suggestion stays dismissed — re-proposing it every night is
    // how an advice list becomes noise someone stops reading.
    if (s.advice?.status === 'DISMISSED') continue;

    const result = adviceFor(
      s.filterShape as unknown as FilterShapeItem[],
      s.sortKeys as unknown as SortKey[],
    );
    if (!result) continue;

    await prisma.advice.upsert({
      where: { signatureId: s.id },
      create: { signatureId: s.id, suggestion: result.suggestion, rationale: result.rationale },
      update: { suggestion: result.suggestion, rationale: result.rationale },
    });
    written += 1;
  }
  return written;
}
