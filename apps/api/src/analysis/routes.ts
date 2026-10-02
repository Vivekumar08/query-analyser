import type { FastifyInstance } from 'fastify';
import { requireAppRole } from '../orgs/rbac.js';
import { percentileFromHist, avgMs } from './percentile.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const SEVEN_DAYS_MS = 7 * 86_400_000;
const HIST_LENGTH = 8;

type Grain = 'hourly' | 'daily';

interface Window {
  from: Date;
  to: Date;
  grain: Grain;
}

/**
 * The caller does not choose the grain. Retention means the choice is not
 * free: 30 days of hourly rollups do not exist, they were compacted and
 * pruned. Every response states which grain answered it.
 */
function resolveWindow(q: { from?: string; to?: string }): Window {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 86_400_000);
  const grain: Grain = to.getTime() - from.getTime() > SEVEN_DAYS_MS ? 'daily' : 'hourly';
  return { from, to, grain };
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

interface RankRow {
  hash: string;
  signature: string;
  model: string;
  operation: string;
  count: number;
  totalMs: bigint;
  maxMs: number;
  hist: number[];
}

function toItem(r: RankRow) {
  return {
    hash: r.hash,
    signature: r.signature,
    model: r.model,
    operation: r.operation,
    count: r.count,
    totalMs: r.totalMs,
    maxMs: r.maxMs,
    avgMs: avgMs(r.totalMs, r.count),
    p95: percentileFromHist(r.hist, r.maxMs, 0.95),
  };
}

function pointOf(r: { count: number; totalMs: bigint; maxMs: number; hist: number[] }) {
  return {
    count: r.count,
    totalMs: r.totalMs,
    maxMs: r.maxMs,
    avgMs: avgMs(r.totalMs, r.count),
    p95: percentileFromHist(r.hist, r.maxMs, 0.95),
  };
}

export default async function analysisRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: [app.authenticate, requireAppRole('VIEWER')] };

  app.get('/v1/apps/:id/queries', read, async (req) => {
    const q = req.query as { from?: string; to?: string; model?: string; op?: string; limit?: string };
    const { from, to, grain } = resolveWindow(q);
    const limit = clampLimit(q.limit);
    const model = q.model ?? null;
    const op = q.op ?? null;

    const rows =
      grain === 'hourly'
        ? await app.prisma.$queryRaw<RankRow[]>`
            WITH agg AS (
              SELECT s.id AS sig_id, s.hash, s.signature, s.model, s.operation,
                     SUM(r."count")::int AS count,
                     SUM(r."totalMs")    AS "totalMs",
                     MAX(r."maxMs")::int AS "maxMs"
              FROM "QuerySignature" s
              JOIN "QueryRollup" r ON r."signatureId" = s.id
              WHERE s."appId" = ${req.appId}
                AND r."bucketHour" BETWEEN ${from} AND ${to}
                AND (${model}::text IS NULL OR s.model = ${model})
                AND (${op}::text IS NULL OR s.operation = ${op})
              GROUP BY s.id, s.hash, s.signature, s.model, s.operation
              ORDER BY SUM(r."totalMs") DESC
              LIMIT ${limit}
            )
            SELECT a.hash, a.signature, a.model, a.operation, a.count, a."totalMs", a."maxMs",
                   (
                     SELECT ARRAY(
                       SELECT SUM(h)::int
                       FROM "QueryRollup" r2, unnest(r2.hist) WITH ORDINALITY AS u(h, idx)
                       WHERE r2."signatureId" = a.sig_id
                         AND r2."bucketHour" BETWEEN ${from} AND ${to}
                       GROUP BY idx ORDER BY idx
                     )
                   ) AS hist
            FROM agg a
            ORDER BY a."totalMs" DESC
          `
        : await app.prisma.$queryRaw<RankRow[]>`
            WITH agg AS (
              SELECT s.id AS sig_id, s.hash, s.signature, s.model, s.operation,
                     SUM(d."count")::int AS count,
                     SUM(d."totalMs")    AS "totalMs",
                     MAX(d."maxMs")::int AS "maxMs"
              FROM "QuerySignature" s
              JOIN "QueryDailyRollup" d ON d."signatureId" = s.id
              WHERE s."appId" = ${req.appId}
                AND d.day BETWEEN ${from} AND ${to}
                AND (${model}::text IS NULL OR s.model = ${model})
                AND (${op}::text IS NULL OR s.operation = ${op})
              GROUP BY s.id, s.hash, s.signature, s.model, s.operation
              ORDER BY SUM(d."totalMs") DESC
              LIMIT ${limit}
            )
            SELECT a.hash, a.signature, a.model, a.operation, a.count, a."totalMs", a."maxMs",
                   (
                     SELECT ARRAY(
                       SELECT SUM(h)::int
                       FROM "QueryDailyRollup" d2, unnest(d2.hist) WITH ORDINALITY AS u(h, idx)
                       WHERE d2."signatureId" = a.sig_id
                         AND d2.day BETWEEN ${from} AND ${to}
                       GROUP BY idx ORDER BY idx
                     )
                   ) AS hist
            FROM agg a
            ORDER BY a."totalMs" DESC
          `;

    return {
      grain,
      limit,
      from: from.toISOString(),
      to: to.toISOString(),
      items: rows.map((r) => toItem({ ...r, hist: r.hist ?? new Array(HIST_LENGTH).fill(0) })),
    };
  });

  app.get('/v1/apps/:id/queries/:sig', read, async (req, reply) => {
    const { sig } = req.params as { sig: string };
    const signature = await app.prisma.querySignature.findFirst({
      where: { appId: req.appId, hash: sig },
      include: { advice: true },
    });
    if (!signature) return reply.code(404).send({ error: 'Not Found' });

    const rollups = await app.prisma.queryRollup.findMany({
      where: { signatureId: signature.id },
    });

    const count = rollups.reduce((n, r) => n + r.count, 0);
    const totalMs = rollups.reduce((n, r) => n + r.totalMs, 0n);
    const maxMs = rollups.reduce((n, r) => Math.max(n, r.maxMs), 0);
    const hist = sumHists(rollups.map((r) => r.hist));

    return {
      hash: signature.hash,
      signature: signature.signature,
      model: signature.model,
      operation: signature.operation,
      firstSeen: signature.firstSeen,
      lastSeen: signature.lastSeen,
      count,
      totalMs,
      maxMs,
      avgMs: avgMs(totalMs, count),
      p95: percentileFromHist(hist, maxMs, 0.95),
      p99: percentileFromHist(hist, maxMs, 0.99),
      hist,
      redactedSample: signature.redactedSample,
      advice: signature.advice,
    };
  });

  app.get('/v1/apps/:id/queries/:sig/series', read, async (req, reply) => {
    const { sig } = req.params as { sig: string };
    const { from, to, grain } = resolveWindow(req.query as { from?: string; to?: string });

    const signature = await app.prisma.querySignature.findFirst({
      where: { appId: req.appId, hash: sig },
      select: { id: true },
    });
    if (!signature) return reply.code(404).send({ error: 'Not Found' });

    const points =
      grain === 'hourly'
        ? (
            await app.prisma.queryRollup.findMany({
              where: { signatureId: signature.id, bucketHour: { gte: from, lte: to } },
              orderBy: { bucketHour: 'asc' },
            })
          ).map((r) => ({ at: r.bucketHour, ...pointOf(r) }))
        : (
            await app.prisma.queryDailyRollup.findMany({
              where: { signatureId: signature.id, day: { gte: from, lte: to } },
              orderBy: { day: 'asc' },
            })
          ).map((r) => ({ at: r.day, ...pointOf(r) }));

    return { grain, from: from.toISOString(), to: to.toISOString(), points };
  });
}

function sumHists(hists: number[][]): number[] {
  const out = new Array(HIST_LENGTH).fill(0) as number[];
  for (const h of hists) for (let i = 0; i < HIST_LENGTH; i += 1) out[i] = (out[i] ?? 0) + (h[i] ?? 0);
  return out;
}
