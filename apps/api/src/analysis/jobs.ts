import type { PrismaClient } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { compactDay, pruneHourly, pruneDaily } from './compaction.js';
import { detectRegression, type HourPoint } from './regression.js';
import { percentileFromHist } from './percentile.js';
import { adviceFor, type SuggestionField } from './advice.js';
import type { FilterShapeItem, SortKey } from '@query-analyser/contract/runtime';

/**
 * `SuggestionField[]` is structurally an `InputJsonArray` (every field is a
 * plain string/number), but TypeScript can't see that through the named
 * interface — it checks `InputJsonObject`'s index signature against the
 * array type first and stops there. This asserts through the one type that
 * is true of every `AdviceSuggestion` this module ever produces, instead of
 * reaching for `any`.
 */
function asJsonArray(suggestion: SuggestionField[]): Prisma.InputJsonArray {
  return suggestion as unknown as Prisma.InputJsonArray;
}

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
const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

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
  //
  // The hourly cutoff is truncated to UTC midnight so hourly rows are only
  // ever deleted in WHOLE days. `daysAgo(now, 7)` is an *instant*: pruning at
  // it leaves the oldest retained day half-deleted, and the next night the
  // compaction loop below picks the oldest *surviving* hourly row, rounds it
  // down to UTC midnight — still inside that same, now-fragmentary day — and
  // calls `compactDay` on it again. `compactDay` replaces rather than
  // accumulates, so it faithfully overwrites a correct daily row with a
  // recomputation from the fragment; the night after, the rest of the day is
  // pruned and the day is never revisited, so the undercount (count, totalMs,
  // hist and maxMs, which also drags the p95 floor down) is permanent for the
  // full 90-day daily retention. Truncating makes retention 7-8 days instead
  // of exactly 7, which still satisfies the spec and only strengthens the
  // 7-day trailing median the regression rule depends on.
  const hourlyPruned = await pruneHourly(
    deps.prisma,
    startOfUtcDay(daysAgo(now, HOURLY_RETENTION_DAYS)),
  );
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

  // The ranking window is the SAME trailing 24 hours for everybody. Without
  // the `bucketHour >= since` predicate, an established signature is ranked on
  // up to 7 days of accumulated `totalMs` (hourly retention) while a candidate
  // first seen inside the window has at most 24 hours of it — so a genuinely
  // new expensive query has to be roughly 7x worse than an established one to
  // reach the top ten, and the rule almost never fires. The spec names no
  // window, so this reuses NEW_SIGNATURE_WINDOW_MS: the candidate's own
  // maximum possible age is the only window in which the comparison is fair.
  const rows = await deps.prisma.$queryRaw<{ id: string; appId: string; firstSeen: Date }[]>`
    WITH ranked AS (
      SELECT s.id, s."appId", s."firstSeen",
             row_number() OVER (PARTITION BY s."appId" ORDER BY sum(r."totalMs") DESC) AS rank
      FROM "QuerySignature" s
      JOIN "QueryRollup" r ON r."signatureId" = s.id
      WHERE r."bucketHour" >= ${since}
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

/**
 * Page sizes for {@link refreshAdvice}. The point of batching is that neither
 * query's result set grows with the size of the installation, so these are
 * deliberately small enough that one page is an unremarkable allocation even
 * for a tenant with tens of thousands of distinct signatures.
 */
const ADVICE_APP_PAGE = 100;
const ADVICE_SIGNATURE_PAGE = 500;

/**
 * `suggestion` is an ordered array of `{ field, dir }` pairs — array order is
 * semantically meaningful (it is the index key) and, unlike object key
 * order, Postgres `jsonb` *does* preserve array order, so a stored row's
 * array always comes back in the order it was written. This still needs a
 * structural comparison rather than `===`: it has to ignore the (meaningless)
 * internal key order jsonb may apply within each `{ field, dir }` object, and
 * Prisma returns a fresh object graph that would never be `===` to one this
 * process computed even with identical contents.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Rewrites index advice for every signature that needs it.
 *
 * Deliberately NOT one `findMany` over `QuerySignature`. An unbounded
 * `findMany` loads `filterShape` and `sortKeys` for every signature in every
 * app into this process's heap; the spec allows exactly one of those (the
 * admin surface) and says "this phase does not add a second one" — least of
 * all inside an unattended nightly job, where the OOM has no request to fail
 * and nobody watching. Apps are paged by id cursor, and each app's signatures
 * are paged by id cursor within it, so peak resident rows is
 * ADVICE_APP_PAGE + ADVICE_SIGNATURE_PAGE regardless of installation size.
 */
async function refreshAdvice(prisma: PrismaClient): Promise<number> {
  let written = 0;
  let appCursor: string | undefined;

  for (;;) {
    const apps = await prisma.app.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
      take: ADVICE_APP_PAGE,
      ...(appCursor ? { cursor: { id: appCursor }, skip: 1 } : {}),
    });
    if (apps.length === 0) break;
    appCursor = apps[apps.length - 1]?.id;

    for (const a of apps) written += await refreshAdviceForApp(prisma, a.id);

    if (apps.length < ADVICE_APP_PAGE) break;
  }

  return written;
}

async function refreshAdviceForApp(prisma: PrismaClient, appId: string): Promise<number> {
  let written = 0;
  let cursor: string | undefined;

  for (;;) {
    const signatures = await prisma.querySignature.findMany({
      where: { appId },
      select: {
        id: true,
        filterShape: true,
        sortKeys: true,
        advice: { select: { status: true, suggestion: true, rationale: true } },
      },
      orderBy: { id: 'asc' },
      take: ADVICE_SIGNATURE_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (signatures.length === 0) break;
    cursor = signatures[signatures.length - 1]?.id;

    for (const s of signatures) {
      // A dismissed suggestion stays dismissed — re-proposing it every night is
      // how an advice list becomes noise someone stops reading.
      if (s.advice?.status === 'DISMISSED') continue;

      const result = adviceFor(
        s.filterShape as unknown as FilterShapeItem[],
        s.sortKeys as unknown as SortKey[],
      );
      if (!result) continue;

      // Nothing to write when the shape has not changed since the last advice
      // write. `filterShape`/`sortKeys` are set once at insert and never
      // updated (ingest/writer.ts's ON CONFLICT touches only `lastSeen` and
      // `redactedSample`), so for a steady-state installation this skips
      // essentially every row and the nightly job stops rewriting the whole
      // table — including the `updatedAt` churn that made a human-set
      // APPLIED status look like it had just been re-proposed.
      if (
        s.advice &&
        s.advice.rationale === result.rationale &&
        canonical(s.advice.suggestion) === canonical(result.suggestion)
      ) {
        continue;
      }

      await prisma.advice.upsert({
        where: { signatureId: s.id },
        create: {
          signatureId: s.id,
          suggestion: asJsonArray(result.suggestion),
          rationale: result.rationale,
        },
        update: { suggestion: asJsonArray(result.suggestion), rationale: result.rationale },
      });
      written += 1;
    }

    if (signatures.length < ADVICE_SIGNATURE_PAGE) break;
  }

  return written;
}
