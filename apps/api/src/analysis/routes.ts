import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../db.js';
import { requireAppRole } from '../orgs/rbac.js';
import { percentileFromHist, avgMs } from './percentile.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const SEVEN_DAYS_MS = 7 * 86_400_000;
const HIST_LENGTH = 8;

type Grain = 'hourly' | 'daily';

interface ResolvedWindow {
  from: Date;
  to: Date;
  grain: Grain;
}

const SORT_KEYS = ['wasted', 'count', 'p95', 'maxMs'] as const;
type SortKey = (typeof SORT_KEYS)[number];

function isParsableDate(v: string): boolean {
  return !Number.isNaN(Date.parse(v));
}

const isoDate = z.string().refine(isParsableDate, { message: 'invalid date' });

/**
 * Covers all five documented query params on the ranked-list route. Every
 * field is a bare `z.string()` (or narrower), which is itself what rejects
 * a repeated param: Fastify's querystring parser turns `?model=a&model=b`
 * into `model: ['a', 'b']`, and `z.string()` fails on an array, so the
 * request 400s instead of reaching `$queryRaw` with an array bound where a
 * scalar is expected.
 */
const listQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  model: z.string().min(1).max(200).optional(),
  op: z.string().min(1).max(200).optional(),
  sort: z.enum(SORT_KEYS).optional(),
  limit: z.string().regex(/^\d+$/, { message: 'limit must be a positive integer' }).optional(),
});

/** `from`/`to` only — the detail and series routes take no other filter. */
const windowQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/**
 * The caller does not choose the grain. Retention means the choice is not
 * free: 30 days of hourly rollups do not exist, they were compacted and
 * pruned. Every response states which grain answered it.
 */
function resolveWindow(q: { from?: string; to?: string }): ResolvedWindow {
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

export interface RankRow {
  hash: string;
  signature: string;
  model: string;
  operation: string;
  count: number;
  totalMs: bigint;
  maxMs: number;
  hist: number[];
}

export interface RankParams {
  appId: string;
  from: Date;
  to: Date;
  model: string | null;
  op: string | null;
  limit: number;
}

/**
 * Ranks signatures by total wasted time within the window and returns only
 * the top `limit` (≤200) rows — the `LIMIT` lives inside the `agg` CTE, so
 * the join against `QueryRollup` is the only part of this query that scans
 * more than `limit` rows; the per-row histogram sum below only runs for
 * signatures that already made the cut.
 *
 * `SUM(r."totalMs")` over a `BigInt` column comes back from Postgres as
 * `numeric` (Prisma/decimal.js `Decimal`), not `bigint` — the explicit
 * `::bigint` cast is load-bearing: without it, `RankRow.totalMs: bigint` is
 * a type-level lie `tsc` cannot catch (the generic on `$queryRaw` is
 * unchecked), and the `'1000'` in a JSON response would come from
 * decimal.js's own `toJSON`, not from `app.ts`'s BigInt-safe reply
 * serializer — a different, uninspected mechanism that happens to produce
 * the same string for any magnitude this service has seen so far.
 */
export async function queryHourlyRanking(prisma: PrismaClient, p: RankParams): Promise<RankRow[]> {
  return prisma.$queryRaw<RankRow[]>`
    WITH agg AS (
      SELECT s.id AS sig_id, s.hash, s.signature, s.model, s.operation,
             SUM(r."count")::int    AS count,
             SUM(r."totalMs")::bigint AS "totalMs",
             MAX(r."maxMs")::int    AS "maxMs"
      FROM "QuerySignature" s
      JOIN "QueryRollup" r ON r."signatureId" = s.id
      WHERE s."appId" = ${p.appId}
        AND r."bucketHour" BETWEEN ${p.from} AND ${p.to}
        AND (${p.model}::text IS NULL OR s.model = ${p.model})
        AND (${p.op}::text IS NULL OR s.operation = ${p.op})
      GROUP BY s.id, s.hash, s.signature, s.model, s.operation
      ORDER BY SUM(r."totalMs") DESC
      LIMIT ${p.limit}
    )
    SELECT a.hash, a.signature, a.model, a.operation, a.count, a."totalMs", a."maxMs",
           (
             SELECT ARRAY(
               SELECT SUM(h)::int
               FROM "QueryRollup" r2, unnest(r2.hist) WITH ORDINALITY AS u(h, idx)
               WHERE r2."signatureId" = a.sig_id
                 AND r2."bucketHour" BETWEEN ${p.from} AND ${p.to}
               GROUP BY idx ORDER BY idx
             )
           ) AS hist
    FROM agg a
    ORDER BY a."totalMs" DESC
  `;
}

/** Same shape and same `::bigint` cast as {@link queryHourlyRanking}, reading the daily rollup table instead. */
export async function queryDailyRanking(prisma: PrismaClient, p: RankParams): Promise<RankRow[]> {
  return prisma.$queryRaw<RankRow[]>`
    WITH agg AS (
      SELECT s.id AS sig_id, s.hash, s.signature, s.model, s.operation,
             SUM(d."count")::int    AS count,
             SUM(d."totalMs")::bigint AS "totalMs",
             MAX(d."maxMs")::int    AS "maxMs"
      FROM "QuerySignature" s
      JOIN "QueryDailyRollup" d ON d."signatureId" = s.id
      WHERE s."appId" = ${p.appId}
        AND d.day BETWEEN ${p.from} AND ${p.to}
        AND (${p.model}::text IS NULL OR s.model = ${p.model})
        AND (${p.op}::text IS NULL OR s.operation = ${p.op})
      GROUP BY s.id, s.hash, s.signature, s.model, s.operation
      ORDER BY SUM(d."totalMs") DESC
      LIMIT ${p.limit}
    )
    SELECT a.hash, a.signature, a.model, a.operation, a.count, a."totalMs", a."maxMs",
           (
             SELECT ARRAY(
               SELECT SUM(h)::int
               FROM "QueryDailyRollup" d2, unnest(d2.hist) WITH ORDINALITY AS u(h, idx)
               WHERE d2."signatureId" = a.sig_id
                 AND d2.day BETWEEN ${p.from} AND ${p.to}
               GROUP BY idx ORDER BY idx
             )
           ) AS hist
    FROM agg a
    ORDER BY a."totalMs" DESC
  `;
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

/**
 * Re-orders the already wasted-time-ranked, `limit`-capped page returned by
 * {@link queryHourlyRanking}/{@link queryDailyRanking} — it never changes
 * *which* signatures made the cut, only the order they're returned in.
 * `p95` is computed here in TypeScript (`percentileFromHist`), not in SQL,
 * so sorting by it in the database isn't straightforward; re-sorting a page
 * capped at `MAX_LIMIT` (200) rows in memory is cheap and keeps every sort
 * key's comparison logic in one place instead of splitting it between SQL
 * and TypeScript.
 */
function sortItems(items: ReturnType<typeof toItem>[], sort: SortKey): ReturnType<typeof toItem>[] {
  const keyOf = (it: ReturnType<typeof toItem>): number => {
    switch (sort) {
      case 'count':
        return it.count;
      case 'p95':
        return it.p95.value;
      case 'maxMs':
        return it.maxMs;
      case 'wasted':
        return Number(it.totalMs);
    }
  };
  return [...items].sort((a, b) => keyOf(b) - keyOf(a));
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

  app.get('/v1/apps/:id/queries', read, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' });
    const q = parsed.data;

    const { from, to, grain } = resolveWindow(q);
    const limit = clampLimit(q.limit);
    const model = q.model ?? null;
    const op = q.op ?? null;
    const sort: SortKey = q.sort ?? 'wasted';

    const params: RankParams = { appId: req.appId, from, to, model, op, limit };
    const rows = grain === 'hourly' ? await queryHourlyRanking(app.prisma, params) : await queryDailyRanking(app.prisma, params);

    const items = sortItems(
      rows.map((r) => toItem({ ...r, hist: r.hist ?? new Array(HIST_LENGTH).fill(0) })),
      sort,
    );

    return {
      grain,
      limit,
      from: from.toISOString(),
      to: to.toISOString(),
      items,
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
    const parsedQuery = windowQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return reply.code(400).send({ error: 'invalid query' });

    const { sig } = req.params as { sig: string };
    const { from, to, grain } = resolveWindow(parsedQuery.data);

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

  const write = { preHandler: [app.authenticate, requireAppRole('MEMBER')] };

  app.get('/v1/apps/:id/alerts', read, async (req) => {
    const items = await app.prisma.alert.findMany({
      where: { signature: { appId: req.appId } },
      orderBy: { detectedAt: 'desc' },
      take: MAX_LIMIT,
      include: { signature: { select: { hash: true, signature: true } } },
    });
    return { items };
  });

  app.patch('/v1/apps/:id/alerts/:alertId', write, async (req, reply) => {
    const { alertId } = req.params as { alertId: string };
    // The id comes from the URL, so it is gated against this app before any
    // write — the standing rule in this repo.
    const found = await app.prisma.alert.findFirst({
      where: { id: alertId, signature: { appId: req.appId } },
      select: { id: true },
    });
    if (!found) return reply.code(404).send({ error: 'Not Found' });

    return app.prisma.alert.update({
      where: { id: alertId },
      data: { acknowledgedAt: new Date() },
    });
  });

  app.get('/v1/apps/:id/advice', read, async (req) => {
    const items = await app.prisma.advice.findMany({
      where: { signature: { appId: req.appId } },
      take: MAX_LIMIT,
      include: { signature: { select: { hash: true, signature: true, model: true } } },
    });
    return { items };
  });

  app.patch('/v1/apps/:id/advice/:adviceId', write, async (req, reply) => {
    const { adviceId } = req.params as { adviceId: string };
    const { status } = (req.body ?? {}) as { status?: string };
    if (status !== 'APPLIED' && status !== 'DISMISSED') {
      return reply.code(400).send({ error: 'status must be APPLIED or DISMISSED' });
    }

    const found = await app.prisma.advice.findFirst({
      where: { id: adviceId, signature: { appId: req.appId } },
      select: { id: true },
    });
    if (!found) return reply.code(404).send({ error: 'Not Found' });

    return app.prisma.advice.update({ where: { id: adviceId }, data: { status } });
  });
}

function sumHists(hists: number[][]): number[] {
  const out = new Array(HIST_LENGTH).fill(0) as number[];
  for (const h of hists) for (let i = 0; i < HIST_LENGTH; i += 1) out[i] = (out[i] ?? 0) + (h[i] ?? 0);
  return out;
}
