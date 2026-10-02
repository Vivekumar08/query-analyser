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
  // `^\d+$` admitted '0' (and '00'), which `clampLimit` then silently turned
  // into the default 50 — a caller asking for nothing got a full page.
  limit: z.string().regex(/^[1-9]\d*$/, { message: 'limit must be a positive integer' }).optional(),
});

/** `from`/`to` only — the detail and series routes take no other filter. */
const windowQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** Only `APPLIED`/`DISMISSED` are settable through the API — `OPEN` is the default, never a target. */
const adviceStatusSchema = z.object({ status: z.enum(['APPLIED', 'DISMISSED']) });

const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * The caller does not choose the grain. Retention means the choice is not
 * free: 30 days of hourly rollups do not exist, they were compacted and
 * pruned. Every response states which grain answered it.
 *
 * Returns `null` for an inverted window (`from` after `to`), which the routes
 * turn into a 400. It previously sailed through to a `BETWEEN` that cannot
 * match, so a transposed pair of dates — the easiest mistake to make with two
 * params of the same shape — answered a cheerful empty 200 that is
 * indistinguishable from "no traffic in that window".
 *
 * `from` is truncated to UTC midnight for the daily grain, because
 * `QueryDailyRollup.day` *is* UTC midnight: comparing it against an instant
 * excluded the oldest day of every window, so "last 30 days" returned 29.
 */
function resolveWindow(q: { from?: string; to?: string }): ResolvedWindow | null {
  const to = q.to ? new Date(q.to) : new Date();
  const requestedFrom = q.from ? new Date(q.from) : new Date(to.getTime() - 86_400_000);
  if (requestedFrom.getTime() > to.getTime()) return null;
  const grain: Grain = to.getTime() - requestedFrom.getTime() > SEVEN_DAYS_MS ? 'daily' : 'hourly';
  const from = grain === 'daily' ? startOfUtcDay(requestedFrom) : requestedFrom;
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
  /**
   * Which ranking the `LIMIT` is applied to. Only the three keys SQL can
   * compute are accepted here — `p95` is computed in TypeScript after the
   * limit, so the route handles it separately and says so in the response.
   */
  sort: SqlSortKey;
}

/** The sort keys the database can rank by, so `limit` selects the right rows. */
export const SQL_SORT_KEYS = ['wasted', 'count', 'maxMs'] as const;
export type SqlSortKey = (typeof SQL_SORT_KEYS)[number];
export const isSqlSortKey = (k: SortKey): k is SqlSortKey =>
  (SQL_SORT_KEYS as readonly string[]).includes(k);

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
             MAX(r."maxMs")::int    AS "maxMs",
             CASE ${p.sort}::text
               WHEN 'count' THEN SUM(r."count")::numeric
               WHEN 'maxMs' THEN MAX(r."maxMs")::numeric
               ELSE SUM(r."totalMs")::numeric
             END AS rank_key
      FROM "QuerySignature" s
      JOIN "QueryRollup" r ON r."signatureId" = s.id
      WHERE s."appId" = ${p.appId}
        AND r."bucketHour" BETWEEN ${p.from} AND ${p.to}
        AND (${p.model}::text IS NULL OR s.model = ${p.model})
        AND (${p.op}::text IS NULL OR s.operation = ${p.op})
      GROUP BY s.id, s.hash, s.signature, s.model, s.operation
      ORDER BY rank_key DESC
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
    ORDER BY a.rank_key DESC
  `;
}

/** Same shape and same `::bigint` cast as {@link queryHourlyRanking}, reading the daily rollup table instead. */
export async function queryDailyRanking(prisma: PrismaClient, p: RankParams): Promise<RankRow[]> {
  return prisma.$queryRaw<RankRow[]>`
    WITH agg AS (
      SELECT s.id AS sig_id, s.hash, s.signature, s.model, s.operation,
             SUM(d."count")::int    AS count,
             SUM(d."totalMs")::bigint AS "totalMs",
             MAX(d."maxMs")::int    AS "maxMs",
             CASE ${p.sort}::text
               WHEN 'count' THEN SUM(d."count")::numeric
               WHEN 'maxMs' THEN MAX(d."maxMs")::numeric
               ELSE SUM(d."totalMs")::numeric
             END AS rank_key
      FROM "QuerySignature" s
      JOIN "QueryDailyRollup" d ON d."signatureId" = s.id
      WHERE s."appId" = ${p.appId}
        AND d.day BETWEEN ${p.from} AND ${p.to}
        AND (${p.model}::text IS NULL OR s.model = ${p.model})
        AND (${p.op}::text IS NULL OR s.operation = ${p.op})
      GROUP BY s.id, s.hash, s.signature, s.model, s.operation
      ORDER BY rank_key DESC
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
    ORDER BY a.rank_key DESC
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
 * Re-orders an already-ranked, `limit`-capped page — it never changes *which*
 * signatures made the cut, only the order they're returned in.
 *
 * This is now reached for `sort=p95` ONLY. `wasted`, `count` and `maxMs` rank
 * inside the `agg` CTE, so their `LIMIT` selects the top `limit` rows *by the
 * requested key*. Re-ordering a page here instead meant `?sort=count&limit=50`
 * returned the 50 worst by wasted time re-ordered by count — a set that can
 * share nothing with the 50 worst by count.
 *
 * `p95` genuinely cannot move into SQL: it comes from `percentileFromHist`
 * over a summed histogram, in TypeScript, after the rows are fetched. So for
 * `p95` the page re-order is still the only cheap option — and the response
 * says so (`sortExact: false`) rather than hiding an approximation behind the
 * same parameter name as the three exact ones.
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

    const window = resolveWindow(q);
    if (!window) return reply.code(400).send({ error: 'from must not be after to' });
    const { from, to, grain } = window;
    const limit = clampLimit(q.limit);
    const model = q.model ?? null;
    const op = q.op ?? null;
    const sort: SortKey = q.sort ?? 'wasted';

    // `sort` chooses the RANKING the `LIMIT` is applied to, not the order of a
    // page already chosen by something else. `p95` is the one key SQL cannot
    // rank by, so it falls back to ranking by wasted time and re-ordering the
    // page — and the response marks that as inexact.
    const exact = isSqlSortKey(sort);
    const params: RankParams = {
      appId: req.appId,
      from,
      to,
      model,
      op,
      limit,
      sort: exact ? sort : 'wasted',
    };
    const rows = grain === 'hourly' ? await queryHourlyRanking(app.prisma, params) : await queryDailyRanking(app.prisma, params);

    const page = rows.map((r) => toItem({ ...r, hist: r.hist ?? new Array(HIST_LENGTH).fill(0) }));
    const items = exact ? page : sortItems(page, sort);

    return {
      grain,
      limit,
      sort,
      sortExact: exact,
      ...(exact
        ? {}
        : {
            sortNote:
              'p95 is computed after the limit is applied, so these are the top `limit` signatures by wasted time, re-ordered by p95 — not the top `limit` by p95.',
          }),
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
    const window = resolveWindow(parsedQuery.data);
    if (!window) return reply.code(400).send({ error: 'from must not be after to' });
    const { from, to, grain } = window;

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
    // write — the standing rule in this repo. The gate is part of the UPDATE's
    // own filter rather than a `findFirst` before it: proving ownership and
    // then acting on it in two statements is a TOCTOU window, and while
    // `QuerySignature.appId` is never updated anywhere (so there is nothing to
    // exploit today), `update({ where: { id } })` throws P2025 if the row is
    // deleted in that window — an app or org cascade-delete is enough — and
    // the global error handler turns that into a 500 for what is a 404.
    try {
      return await app.prisma.alert.update({
        where: { id: alertId, signature: { appId: req.appId } },
        data: { acknowledgedAt: new Date() },
      });
    } catch (err) {
      if (isRecordNotFound(err)) return reply.code(404).send({ error: 'Not Found' });
      throw err;
    }
  });

  app.get('/v1/apps/:id/advice', read, async (req) => {
    const items = await app.prisma.advice.findMany({
      where: { signature: { appId: req.appId } },
      // Without an `orderBy`, which 200 rows a `take` returns is up to the
      // planner, so the same request could answer differently run to run.
      // `alerts` above already orders; this is the same fix.
      orderBy: { updatedAt: 'desc' },
      take: MAX_LIMIT,
      include: { signature: { select: { hash: true, signature: true, model: true } } },
    });
    return { items };
  });

  app.patch('/v1/apps/:id/advice/:adviceId', write, async (req, reply) => {
    const { adviceId } = req.params as { adviceId: string };
    const parsed = adviceStatusSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const { status } = parsed.data;

    // Atomic, for the reasons on the alerts route above.
    try {
      return await app.prisma.advice.update({
        where: { id: adviceId, signature: { appId: req.appId } },
        data: { status },
      });
    } catch (err) {
      if (isRecordNotFound(err)) return reply.code(404).send({ error: 'Not Found' });
      throw err;
    }
  });
}

/**
 * Prisma's "an operation failed because it depends on one or more records that
 * were required but not found". Narrowed to that one code on purpose: a bare
 * `catch` around an `update` would turn a connection failure or a constraint
 * violation into a 404 too.
 */
function isRecordNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025';
}

function sumHists(hists: number[][]): number[] {
  const out = new Array(HIST_LENGTH).fill(0) as number[];
  for (const h of hists) for (let i = 0; i < HIST_LENGTH; i += 1) out[i] = (out[i] ?? 0) + (h[i] ?? 0);
  return out;
}
