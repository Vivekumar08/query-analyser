# Analysis and Read APIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the rollups the ingest path is already collecting into percentiles, trends, regression alerts and index advice, exposed through seven read endpoints.

**Architecture:** A new `apps/api/src/analysis/` module. Bulk row work (compaction, pruning, ranking) is set-based SQL because it grows with the customer base. Arithmetic (percentiles, the regression rule, index advice) is pure TypeScript taking plain inputs and returning plain outputs, because every arithmetic bug this project has caught was caught by a unit test on a pure function. Jobs are plain async functions that know nothing about timers, so moving to BullMQ later replaces the scheduler rather than the analysis.

**Tech Stack:** Fastify 5, Prisma 7, PostgreSQL 17, vitest, TypeScript (strict, `noUncheckedIndexedAccess`).

**Spec:** `docs/superpowers/specs/2026-10-01-analysis-and-read-apis-design.md`

## Global Constraints

- Tests run from `apps/api` with `npx vitest run`. Baseline is **114/114 green**; every task must leave it at least that plus its own tests.
- `npx tsc --noEmit` from `apps/api` must stay clean. No `any` casts.
- Local Postgres is Homebrew at `postgresql://qa:qa@localhost:5432/qa`. **Docker is dead on this machine** — nothing in this plan may depend on it.
- Commit with `git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "..."`. Do not push.
- **Do not use `git checkout --` to undo uncommitted work.** Reverse edits with Edit and check `git status` before and after.
- Every route gets an auth test that **FAILS when its gate is removed**. Every pure helper gets tests that fail under mutation. This was the main review finding in three consecutive tasks of the previous plan.
- `totalMs` is a `BigInt`. The BigInt-safe reply serializer in `apps/api/src/app.ts` renders it as a numeric **string**. Convert with `Number(...)` before arithmetic; never return a raw `BigInt` from a helper.
- `requireAppRole(min)` from `apps/api/src/orgs/rbac.ts` sets `req.membership` and `req.appId`, 404s a non-member with a body identical to a nonexistent app, and 403s a suspended org. Every route in this plan sits behind it.
- `HIST_BOUNDS = [100, 250, 500, 1000, 2500, 5000, 10000]` and `HIST_SIZE = 8` come from `packages/contract/src/runtime.ts`. Never redeclare them.

---

### Task 1: Percentiles from the histogram

**Files:**
- Create: `apps/api/src/analysis/percentile.ts`
- Test: `apps/api/src/analysis/percentile.test.ts`

**Interfaces:**
- Consumes: `HIST_BOUNDS`, `HIST_SIZE` from `@query-analyser/contract/runtime`
- Produces: `percentileFromHist(hist: number[], maxMs: number, p: number): PercentileResult` where `PercentileResult = { value: number; basis: 'interpolated' | 'floor' }`, and `avgMs(totalMs: bigint | number, count: number): number`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/percentile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { percentileFromHist, avgMs } from './percentile.js';

describe('percentileFromHist', () => {
  it('returns zero for an empty histogram', () => {
    expect(percentileFromHist([0, 0, 0, 0, 0, 0, 0, 0], 0, 0.95)).toEqual({
      value: 0,
      basis: 'floor',
    });
  });

  it('interpolates inside the first bucket', () => {
    // 10 observations, all in [0,100). p50 -> rank 5 -> halfway -> 50ms.
    const r = percentileFromHist([10, 0, 0, 0, 0, 0, 0, 0], 80, 0.5);
    expect(r.basis).toBe('interpolated');
    expect(r.value).toBe(50);
  });

  it('never reports a percentile above the observed maximum', () => {
    // Interpolation alone would give 95ms, but nothing slower than 50ms was
    // ever seen. Reporting 95 would be inventing a measurement.
    const r = percentileFromHist([10, 0, 0, 0, 0, 0, 0, 0], 50, 0.95);
    expect(r.value).toBe(50);
  });

  it('interpolates inside a middle bucket', () => {
    // 10 in [0,100), 10 in [250,500). p95 -> rank 19 -> 9th of the 10 in
    // bucket 2 -> 250 + 0.9 * 250 = 475.
    const r = percentileFromHist([10, 0, 10, 0, 0, 0, 0, 0], 600, 0.95);
    expect(r.basis).toBe('interpolated');
    expect(r.value).toBe(475);
  });

  it('reports a floor, not an estimate, when the rank lands in the unbounded top bucket', () => {
    // The last bucket is [10000, infinity) — there is no upper bound to
    // interpolate toward, so the honest answer is the largest value actually
    // observed.
    const r = percentileFromHist([0, 0, 0, 0, 0, 0, 0, 5], 14002, 0.95);
    expect(r).toEqual({ value: 14002, basis: 'floor' });
  });

  it('handles a rank landing exactly on a bucket boundary', () => {
    const r = percentileFromHist([10, 10, 0, 0, 0, 0, 0, 0], 400, 0.5);
    expect(r.value).toBe(100);
  });
});

describe('avgMs', () => {
  it('divides totalMs by count', () => {
    expect(avgMs(900n, 4)).toBe(225);
  });

  it('is zero for a count of zero rather than NaN or Infinity', () => {
    expect(avgMs(0n, 0)).toBe(0);
  });

  it('rounds to two decimals', () => {
    expect(avgMs(100n, 3)).toBe(33.33);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/percentile.test.ts`
Expected: FAIL — cannot find module `./percentile.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/analysis/percentile.ts`:

```ts
import { HIST_BOUNDS, HIST_SIZE } from '@query-analyser/contract/runtime';

export type PercentileBasis = 'interpolated' | 'floor';

export interface PercentileResult {
  /** Milliseconds. */
  value: number;
  /**
   * `interpolated` — the rank fell in a bounded bucket and the value is a
   * linear estimate inside it.
   * `floor` — the rank fell in the unbounded top bucket (or there is no data),
   * so the value is the largest observation actually recorded. The real
   * percentile is at least this.
   */
  basis: PercentileBasis;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Approximates a percentile from the fixed 8-bucket histogram.
 *
 * The spec requires the UI to render this as `p95 ≈`. Returning the basis
 * makes the approximation a property of the data rather than a convention a
 * dashboard author has to remember — and lets a floor render as `p95 ≥`.
 *
 * @param p percentile as a fraction, e.g. 0.95
 */
export function percentileFromHist(hist: number[], maxMs: number, p: number): PercentileResult {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return { value: 0, basis: 'floor' };

  const target = p * total;
  let cumulative = 0;

  for (let i = 0; i < HIST_SIZE; i += 1) {
    const inBucket = hist[i] ?? 0;
    if (cumulative + inBucket >= target && inBucket > 0) {
      const lower = i === 0 ? 0 : (HIST_BOUNDS[i - 1] ?? 0);
      const upper = i === HIST_SIZE - 1 ? null : (HIST_BOUNDS[i] ?? 0);

      // The top bucket has no upper bound. Interpolating toward infinity is
      // meaningless, so report the largest value actually observed.
      if (upper === null) return { value: maxMs, basis: 'floor' };

      const within = (target - cumulative) / inBucket;
      const estimate = lower + (upper - lower) * within;

      // Interpolation can overshoot: ten queries all under 50ms still put p95
      // at 95ms by arithmetic alone. Never report a number nobody measured.
      return { value: round2(Math.min(estimate, maxMs)), basis: 'interpolated' };
    }
    cumulative += inBucket;
  }

  return { value: maxMs, basis: 'floor' };
}

/** `totalMs / count`, as a number. `totalMs` arrives as a BigInt from Prisma. */
export function avgMs(totalMs: bigint | number, count: number): number {
  if (count === 0) return 0;
  return round2(Number(totalMs) / count);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/percentile.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the tests are load-bearing**

Change `Math.min(estimate, maxMs)` to `estimate`. Run the suite — "never reports a percentile above the observed maximum" must FAIL. Restore with Edit (not `git checkout`).

Change `if (upper === null) return { value: maxMs, basis: 'floor' }` to fall through to interpolation using `HIST_BOUNDS[i - 1] * 2` as the upper bound. The floor test must FAIL. Restore.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: 123 tests (114 + 9), typecheck clean.

```bash
git add apps/api/src/analysis/percentile.ts apps/api/src/analysis/percentile.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): approximate percentiles from the rollup histogram

The top bucket is unbounded, so a rank landing there reports the largest
observed value as a floor rather than inventing an interpolation toward
infinity. Interpolation is also clamped to maxMs: ten queries under 50ms
otherwise put p95 at 95ms, a number nobody measured."
```

---

### Task 2: Nightly compaction, hourly into daily

**Files:**
- Create: `apps/api/src/analysis/compaction.ts`
- Test: `apps/api/src/analysis/compaction.test.ts`

**Interfaces:**
- Consumes: `PrismaClient` from `../db.js`
- Produces: `compactDay(prisma, day: Date): Promise<number>`, `pruneHourly(prisma, before: Date): Promise<number>`, `pruneDaily(prisma, before: Date): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/compaction.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { compactDay, pruneHourly, pruneDaily } from './compaction.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let appId: string;
let signatureId: string;

async function seedSignature() {
  const org = await app.prisma.organization.create({
    data: { name: 'Compact Co', slug: `compact-${Date.now()}` },
  });
  const a = await app.prisma.app.create({
    data: { orgId: org.id, name: 'compact', env: 'production' },
  });
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: a.id,
      hash: `h${Date.now()}`.slice(0, 16).padEnd(16, '0'),
      signature: 'users.find({email})',
      model: 'users',
      operation: 'find',
      filterShape: [{ key: 'email', op: 'eq' }],
      sortKeys: [],
      stages: [],
    },
  });
  return { appId: a.id, signatureId: sig.id };
}

beforeEach(async () => {
  app = await buildApp();
  const seeded = await seedSignature();
  appId = seeded.appId;
  signatureId = seeded.signatureId;
});

afterAll(async () => {
  await app?.close();
});

describe('compactDay', () => {
  it('sums hourly rollups into one daily row, adding hist element-wise', async () => {
    await app.prisma.queryRollup.createMany({
      data: [
        {
          signatureId,
          bucketHour: new Date('2026-09-10T01:00:00.000Z'),
          count: 3,
          totalMs: 300n,
          maxMs: 120,
          hist: [1, 2, 0, 0, 0, 0, 0, 0],
        },
        {
          signatureId,
          bucketHour: new Date('2026-09-10T05:00:00.000Z'),
          count: 4,
          totalMs: 800n,
          maxMs: 400,
          hist: [0, 1, 3, 0, 0, 0, 0, 0],
        },
      ],
    });

    const written = await compactDay(app.prisma, new Date('2026-09-10T00:00:00.000Z'));
    expect(written).toBe(1);

    const daily = await app.prisma.queryDailyRollup.findFirstOrThrow({
      where: { signatureId },
    });
    expect(daily.count).toBe(7);
    expect(Number(daily.totalMs)).toBe(1100);
    expect(daily.maxMs).toBe(400);
    expect(daily.hist).toEqual([1, 3, 3, 0, 0, 0, 0, 0]);
  });

  it('is idempotent — running twice does not double the numbers', async () => {
    await app.prisma.queryRollup.create({
      data: {
        signatureId,
        bucketHour: new Date('2026-09-11T02:00:00.000Z'),
        count: 5,
        totalMs: 500n,
        maxMs: 200,
        hist: [5, 0, 0, 0, 0, 0, 0, 0],
      },
    });

    const day = new Date('2026-09-11T00:00:00.000Z');
    await compactDay(app.prisma, day);
    await compactDay(app.prisma, day);

    const daily = await app.prisma.queryDailyRollup.findFirstOrThrow({
      where: { signatureId },
    });
    expect(daily.count).toBe(5);
    expect(Number(daily.totalMs)).toBe(500);
    expect(daily.hist).toEqual([5, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('only compacts the requested day', async () => {
    await app.prisma.queryRollup.createMany({
      data: [
        {
          signatureId,
          bucketHour: new Date('2026-09-12T03:00:00.000Z'),
          count: 1,
          totalMs: 100n,
          maxMs: 100,
          hist: [1, 0, 0, 0, 0, 0, 0, 0],
        },
        {
          signatureId,
          bucketHour: new Date('2026-09-13T03:00:00.000Z'),
          count: 9,
          totalMs: 900n,
          maxMs: 900,
          hist: [0, 0, 0, 9, 0, 0, 0, 0],
        },
      ],
    });

    await compactDay(app.prisma, new Date('2026-09-12T00:00:00.000Z'));

    const rows = await app.prisma.queryDailyRollup.findMany({ where: { signatureId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
  });
});

describe('pruning', () => {
  it('deletes hourly rollups older than the cutoff and leaves newer ones', async () => {
    await app.prisma.queryRollup.createMany({
      data: [
        {
          signatureId,
          bucketHour: new Date('2026-09-01T00:00:00.000Z'),
          count: 1,
          totalMs: 1n,
          maxMs: 1,
          hist: [1, 0, 0, 0, 0, 0, 0, 0],
        },
        {
          signatureId,
          bucketHour: new Date('2026-09-20T00:00:00.000Z'),
          count: 1,
          totalMs: 1n,
          maxMs: 1,
          hist: [1, 0, 0, 0, 0, 0, 0, 0],
        },
      ],
    });

    const deleted = await pruneHourly(app.prisma, new Date('2026-09-10T00:00:00.000Z'));
    expect(deleted).toBe(1);

    const left = await app.prisma.queryRollup.findMany({ where: { signatureId } });
    expect(left).toHaveLength(1);
    expect(left[0]?.bucketHour.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('deletes daily rollups older than the cutoff', async () => {
    await app.prisma.queryDailyRollup.create({
      data: {
        signatureId,
        day: new Date('2026-01-01T00:00:00.000Z'),
        count: 1,
        totalMs: 1n,
        maxMs: 1,
        hist: [1, 0, 0, 0, 0, 0, 0, 0],
      },
    });

    const deleted = await pruneDaily(app.prisma, new Date('2026-06-01T00:00:00.000Z'));
    expect(deleted).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/compaction.test.ts`
Expected: FAIL — cannot find module `./compaction.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/analysis/compaction.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/compaction.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the idempotency test is load-bearing**

Change the `ON CONFLICT` clause to accumulate:

```sql
      "count"   = "QueryDailyRollup"."count"   + EXCLUDED."count",
      "totalMs" = "QueryDailyRollup"."totalMs" + EXCLUDED."totalMs",
```

Run the suite — "is idempotent" must FAIL with count 10 instead of 5. Restore with Edit.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/analysis/compaction.ts apps/api/src/analysis/compaction.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): compact hourly rollups into daily, and prune by retention

Compaction replaces rather than accumulates: recomputing the whole day from
the hourly rows that still exist makes a re-run a no-op, where the natural
accumulate form would double a day's numbers on any retry."
```

---

### Task 3: The regression rule

**Files:**
- Create: `apps/api/src/analysis/regression.ts`
- Test: `apps/api/src/analysis/regression.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `detectRegression(trailing: HourPoint[], latest: HourPoint): RegressionDetail | null`, `REGRESSION_FACTOR`, `MIN_COUNT`, `median(values: number[]): number`; `HourPoint = { p95: number; count: number }`; `RegressionDetail = { kind: 'regression'; latestP95: number; baselineP95: number; factor: number; count: number }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/regression.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectRegression, median, REGRESSION_FACTOR, MIN_COUNT } from './regression.js';

const hour = (p95: number, count = 100) => ({ p95, count });

describe('median', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('takes the middle value for an odd count', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it('is zero for an empty list', () => {
    expect(median([])).toBe(0);
  });
});

describe('detectRegression', () => {
  const trailing = [hour(100), hour(110), hour(90), hour(100), hour(105)];

  it('fires when the latest p95 is more than the factor times the baseline', () => {
    const r = detectRegression(trailing, hour(300));
    expect(r).not.toBeNull();
    expect(r?.kind).toBe('regression');
    expect(r?.baselineP95).toBe(100);
    expect(r?.latestP95).toBe(300);
  });

  it('does not fire at exactly the factor — the rule is strictly greater', () => {
    expect(detectRegression(trailing, hour(100 * REGRESSION_FACTOR))).toBeNull();
  });

  it('does not fire below the count floor, however bad the p95', () => {
    // One cold query at 3am is not a regression. Without this floor every
    // low-traffic signature alerts constantly.
    expect(detectRegression(trailing, hour(5000, MIN_COUNT - 1))).toBeNull();
  });

  it('fires at exactly the count floor', () => {
    expect(detectRegression(trailing, hour(5000, MIN_COUNT))).not.toBeNull();
  });

  it('does not fire with no baseline to regress from', () => {
    expect(detectRegression([], hour(5000))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/regression.test.ts`
Expected: FAIL — cannot find module `./regression.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/analysis/regression.ts`:

```ts
/** A regression is a p95 more than this many times its trailing baseline. */
export const REGRESSION_FACTOR = 2;

/**
 * Minimum observations in the hour before a regression can be reported. One
 * cold query at 3am is not a regression, and without this floor every
 * low-traffic signature alerts constantly.
 */
export const MIN_COUNT = 20;

export interface HourPoint {
  p95: number;
  count: number;
}

export interface RegressionDetail {
  kind: 'regression';
  latestP95: number;
  baselineP95: number;
  factor: number;
  count: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Pure. The caller supplies the trailing window and the last complete hour;
 * this decides whether that constitutes a regression.
 */
export function detectRegression(trailing: HourPoint[], latest: HourPoint): RegressionDetail | null {
  if (trailing.length === 0) return null;
  if (latest.count < MIN_COUNT) return null;

  const baseline = median(trailing.map((h) => h.p95));
  if (baseline <= 0) return null;
  if (latest.p95 <= REGRESSION_FACTOR * baseline) return null;

  return {
    kind: 'regression',
    latestP95: latest.p95,
    baselineP95: baseline,
    factor: Math.round((latest.p95 / baseline) * 100) / 100,
    count: latest.count,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/regression.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify the tests are load-bearing**

Change `if (latest.count < MIN_COUNT) return null;` to `if (latest.count < 0) return null;`. The count-floor test must FAIL. Restore with Edit.

Change `latest.p95 <= REGRESSION_FACTOR * baseline` to `<`. The "does not fire at exactly the factor" test must FAIL. Restore.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/analysis/regression.ts apps/api/src/analysis/regression.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): the regression rule as a pure function

Thresholds are named constants so a future tweak is one edit and the tests can
state them. The count floor is what stops every low-traffic signature alerting
on a single cold query."
```

---

### Task 4: Index advice

**Files:**
- Create: `apps/api/src/analysis/advice.ts`
- Test: `apps/api/src/analysis/advice.test.ts`

**Interfaces:**
- Consumes: `FilterShapeItem`, `SortKey`, `OpClass` types from `@query-analyser/contract/runtime`
- Produces: `adviceFor(filterShape: FilterShapeItem[], sortKeys: SortKey[]): AdviceSuggestion | null` where `AdviceSuggestion = { suggestion: Record<string, 1 | -1>; rationale: string }`

**Ruling carried from planning:** the spec's Equality–Sort–Range rule names `regex`, `ne` and `other` as excluded and leaves `exists` unplaced. This plan treats `exists` as **range-class** — it is not an equality match on a value. A reviewer should see this as a decision, not an oversight.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/advice.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { adviceFor } from './advice.js';

describe('adviceFor', () => {
  it('orders equality, then sort, then range', () => {
    const r = adviceFor(
      [
        { key: 'status', op: 'eq' },
        { key: 'createdAt', op: 'range' },
      ],
      [{ key: 'placedAt', dir: -1 }],
    );
    expect(Object.keys(r!.suggestion)).toEqual(['status', 'placedAt', 'createdAt']);
    expect(r!.suggestion).toEqual({ status: 1, placedAt: -1, createdAt: 1 });
  });

  it('treats $in as equality', () => {
    const r = adviceFor([{ key: 'tenant', op: 'in' }], []);
    expect(Object.keys(r!.suggestion)).toEqual(['tenant']);
  });

  it('excludes regex, ne and other, and names them in the rationale', () => {
    const r = adviceFor(
      [
        { key: 'status', op: 'eq' },
        { key: 'name', op: 'regex' },
        { key: 'kind', op: 'ne' },
        { key: 'misc', op: 'other' },
      ],
      [],
    );
    expect(Object.keys(r!.suggestion)).toEqual(['status']);
    expect(r!.rationale).toContain('name');
    expect(r!.rationale).toContain('kind');
    expect(r!.rationale).toContain('misc');
  });

  it('places exists after the sort keys, with the range fields', () => {
    const r = adviceFor(
      [
        { key: 'deletedAt', op: 'exists' },
        { key: 'status', op: 'eq' },
      ],
      [{ key: 'placedAt', dir: 1 }],
    );
    expect(Object.keys(r!.suggestion)).toEqual(['status', 'placedAt', 'deletedAt']);
  });

  it('gives no advice for an empty shape', () => {
    expect(adviceFor([], [])).toBeNull();
  });

  it('gives no advice when the filter is only _id', () => {
    // _id is always indexed. Suggesting it is noise.
    expect(adviceFor([{ key: '_id', op: 'eq' }], [])).toBeNull();
  });

  it('gives no advice when every field is unindexable', () => {
    expect(adviceFor([{ key: 'name', op: 'regex' }], [])).toBeNull();
  });

  it('says plainly that this is a shape heuristic, not a verified plan', () => {
    const r = adviceFor([{ key: 'status', op: 'eq' }], []);
    expect(r!.rationale).toMatch(/heuristic|never seen/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/advice.test.ts`
Expected: FAIL — cannot find module `./advice.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/analysis/advice.ts`:

```ts
import type { FilterShapeItem, SortKey, OpClass } from '@query-analyser/contract/runtime';

export interface AdviceSuggestion {
  /** Field order matters — this is the index key, not a set. */
  suggestion: Record<string, 1 | -1>;
  rationale: string;
}

const EQUALITY: OpClass[] = ['eq', 'in'];
/** `exists` is not an equality match on a value, so it sits with the ranges. */
const RANGE: OpClass[] = ['range', 'exists'];
const UNINDEXABLE: OpClass[] = ['regex', 'ne', 'other'];

/**
 * Deterministic Equality–Sort–Range index advice derived from query shape.
 *
 * The service has never seen the customer's indexes or collection statistics,
 * so the rationale says so. That honesty is what makes explain()-based
 * evidence a credible v2 rather than a contradiction of v1.
 */
export function adviceFor(
  filterShape: FilterShapeItem[],
  sortKeys: SortKey[],
): AdviceSuggestion | null {
  if (filterShape.length === 0 && sortKeys.length === 0) return null;

  const equality = filterShape.filter((f) => EQUALITY.includes(f.op));
  const range = filterShape.filter((f) => RANGE.includes(f.op));
  const excluded = filterShape.filter((f) => UNINDEXABLE.includes(f.op));

  const indexable = [...equality, ...range];
  // `_id` is always indexed; suggesting it is noise.
  const meaningful = indexable.filter((f) => f.key !== '_id');
  if (meaningful.length === 0 && sortKeys.length === 0) return null;

  const suggestion: Record<string, 1 | -1> = {};
  for (const f of equality) if (f.key !== '_id') suggestion[f.key] = 1;
  for (const s of sortKeys) suggestion[s.key] = s.dir;
  for (const f of range) if (f.key !== '_id') suggestion[f.key] = 1;

  if (Object.keys(suggestion).length === 0) return null;

  const parts = [
    'Equality fields first, then the sort keys in their sort order, then range fields (Equality–Sort–Range).',
  ];
  if (excluded.length > 0) {
    parts.push(
      `Excluded as unindexable in this position: ${excluded.map((f) => `${f.key} (${f.op})`).join(', ')}.`,
    );
  }
  parts.push(
    'This is a heuristic derived from query shape — the service has never seen your indexes or collection statistics.',
  );

  return { suggestion, rationale: parts.join(' ') };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/advice.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify the tests are load-bearing**

Move the `for (const s of sortKeys)` loop below the range loop. The ordering test must FAIL. Restore with Edit.

Remove the `f.key !== '_id'` guard from the equality loop. The `_id`-only test must FAIL. Restore.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/analysis/advice.ts apps/api/src/analysis/advice.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): deterministic Equality-Sort-Range index advice

exists is treated as range-class — it is not an equality match on a value. The
spec left it unplaced, so this is a decision rather than an oversight."
```

---

### Task 5: Job orchestration

**Files:**
- Create: `apps/api/src/analysis/jobs.ts`
- Test: `apps/api/src/analysis/jobs.test.ts`

**Interfaces:**
- Consumes: `compactDay`, `pruneHourly`, `pruneDaily` (Task 2); `detectRegression`, `HourPoint` (Task 3); `adviceFor` (Task 4); `percentileFromHist` (Task 1)
- Produces: `runHourlyJobs(deps: JobDeps): Promise<HourlyResult>`, `runNightlyJobs(deps: JobDeps): Promise<NightlyResult>`; `JobDeps = { prisma: PrismaClient; now?: Date }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/jobs.test.ts`. The ordering test is the point of this task — prune must never run before detection, because hourly retention is 7 days and the regression baseline is a 7-day median:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { buildApp } from '../app.js';
import { runHourlyJobs, runNightlyJobs } from './jobs.js';
import * as compaction from './compaction.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe('runNightlyJobs', () => {
  it('detects before it prunes', async () => {
    // Hourly rollups are kept 7 days and the regression baseline is a 7-day
    // median — exactly equal. Pruning first silently drops the oldest hour
    // out of every baseline.
    const order: string[] = [];
    vi.spyOn(compaction, 'compactDay').mockImplementation(async () => {
      order.push('compact');
      return 0;
    });
    vi.spyOn(compaction, 'pruneHourly').mockImplementation(async () => {
      order.push('prune');
      return 0;
    });
    vi.spyOn(compaction, 'pruneDaily').mockImplementation(async () => 0);

    await runNightlyJobs({ prisma: app.prisma, now: new Date('2026-09-20T02:00:00.000Z') });

    expect(order.indexOf('compact')).toBeLessThan(order.indexOf('prune'));
  });

  it('prunes hourly at 7 days and daily at 90 days from now', async () => {
    const seen: Date[] = [];
    vi.spyOn(compaction, 'compactDay').mockResolvedValue(0);
    vi.spyOn(compaction, 'pruneHourly').mockImplementation(async (_p, before) => {
      seen.push(before);
      return 0;
    });
    vi.spyOn(compaction, 'pruneDaily').mockImplementation(async (_p, before) => {
      seen.push(before);
      return 0;
    });

    const now = new Date('2026-09-20T02:00:00.000Z');
    await runNightlyJobs({ prisma: app.prisma, now });

    expect(seen[0]?.toISOString()).toBe('2026-09-13T02:00:00.000Z');
    expect(seen[1]?.toISOString()).toBe('2026-06-22T02:00:00.000Z');
  });
});

describe('runHourlyJobs', () => {
  it('returns a result without throwing when there is no data at all', async () => {
    const r = await runHourlyJobs({
      prisma: app.prisma,
      now: new Date('2026-09-20T02:00:00.000Z'),
    });
    expect(r.alertsCreated).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/jobs.test.ts`
Expected: FAIL — cannot find module `./jobs.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/analysis/jobs.ts`:

```ts
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

  // Pruning runs LAST. Hourly retention is 7 days and the regression baseline
  // is a 7-day median, so pruning before detection would silently shorten
  // every baseline by an hour.
  const hourlyPruned = await pruneHourly(deps.prisma, daysAgo(now, HOURLY_RETENTION_DAYS));
  const dailyPruned = await pruneDaily(deps.prisma, daysAgo(now, DAILY_RETENTION_DAYS));

  return { daysCompacted, hourlyPruned, dailyPruned, adviceWritten };
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/jobs.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the ordering test is load-bearing**

Move the two `prune*` calls above `compactDay` in `runNightlyJobs`. The "detects before it prunes" test must FAIL. Restore with Edit.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/analysis/jobs.ts apps/api/src/analysis/jobs.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): hourly and nightly analysis jobs

The jobs take their dependencies as an argument and know nothing about timers,
so a BullMQ worker can call them unchanged. Pruning runs last: hourly retention
and the regression baseline are both 7 days, so pruning first would shorten
every baseline."
```

---

### Task 6: The scheduler

**Files:**
- Create: `apps/api/src/analysis/scheduler.ts`
- Modify: `apps/api/src/app.ts` (register the plugin, add `startScheduler` to options)
- Modify: `apps/api/src/server.ts` (pass `startScheduler: true`)
- Test: `apps/api/src/analysis/scheduler.test.ts`

**Interfaces:**
- Consumes: `runHourlyJobs`, `runNightlyJobs` (Task 5)
- Produces: a Fastify plugin; `withJobLock(prisma, key, fn): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/scheduler.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { withJobLock } from './scheduler.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe('withJobLock', () => {
  it('runs the job and reports that it held the lock', async () => {
    let ran = false;
    const held = await withJobLock(app.prisma, 42, async () => {
      ran = true;
    });
    expect(held).toBe(true);
    expect(ran).toBe(true);
  });

  it('skips the job when another holder has the lock', async () => {
    let ran = false;
    const held = await withJobLock(app.prisma, 43, async () => {
      // Taking the same lock from inside is the closest we can get to a
      // second replica without a second connection pool.
      const inner = await withJobLock(app.prisma, 43, async () => {
        ran = true;
      });
      expect(inner).toBe(false);
    });
    expect(held).toBe(true);
    expect(ran).toBe(false);
  });
});

describe('scheduler registration', () => {
  it('does not start timers unless asked', async () => {
    // Tests build dozens of apps; none of them should spawn background work.
    const quiet = await buildApp();
    expect(quiet.analysisTimers).toHaveLength(0);
    await quiet.close();
  });

  it('starts timers when startScheduler is true', async () => {
    const busy = await buildApp({ startScheduler: true });
    expect(busy.analysisTimers.length).toBeGreaterThan(0);
    await busy.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/scheduler.test.ts`
Expected: FAIL — cannot find module `./scheduler.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/analysis/scheduler.ts`:

```ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../db.js';
import { runHourlyJobs, runNightlyJobs } from './jobs.js';

const HOURLY_LOCK = 8_100_001;
const NIGHTLY_LOCK = 8_100_002;
const MINUTE = 60_000;

/**
 * Runs `fn` only if this connection can take the advisory lock, and reports
 * whether it did.
 *
 * TEMPORARY. This exists because the scheduler runs in-process and a second
 * replica would otherwise run every job twice. When the jobs move to BullMQ,
 * its job IDs give the same guarantee and this function should be DELETED
 * rather than kept alongside the queue.
 */
export async function withJobLock(
  prisma: PrismaClient,
  key: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${key}::bigint) AS locked
  `;
  if (!row?.locked) return false;
  try {
    await fn();
    return true;
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${key}::bigint)`;
  }
}

export default fp(async function schedulerPlugin(
  app: FastifyInstance,
  opts: { startScheduler?: boolean },
) {
  const timers: NodeJS.Timeout[] = [];
  app.decorate('analysisTimers', timers);

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  });

  if (!opts.startScheduler) return;

  const tick = (name: string, key: number, fn: () => Promise<unknown>) => async () => {
    try {
      const held = await withJobLock(app.prisma, key, async () => {
        await fn();
      });
      if (!held) app.log.info({ job: name }, 'analysis job skipped, lock held elsewhere');
    } catch (err) {
      // A failing job must never take the service down.
      app.log.error({ err, job: name }, 'analysis job failed');
    }
  };

  // Hourly at :05 — late enough that the hour's last batches have arrived.
  const hourly = tick('hourly', HOURLY_LOCK, () => runHourlyJobs({ prisma: app.prisma }));
  const nightly = tick('nightly', NIGHTLY_LOCK, () => runNightlyJobs({ prisma: app.prisma }));

  timers.push(setInterval(() => void hourly(), 60 * MINUTE));
  timers.push(setInterval(() => void nightly(), 24 * 60 * MINUTE));
});

declare module 'fastify' {
  interface FastifyInstance {
    analysisTimers: NodeJS.Timeout[];
  }
}
```

Modify `apps/api/src/app.ts`: add `startScheduler?: boolean` to the build options interface and register the plugin **after** `prismaPlugin` (it needs `app.prisma`), passing the flag through:

```ts
await app.register(import('./analysis/scheduler.js'), { startScheduler: opts.startScheduler ?? false });
```

Modify `apps/api/src/server.ts`: pass `startScheduler: true` to `buildApp`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/scheduler.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the registration test is load-bearing**

Change the default in `app.ts` from `opts.startScheduler ?? false` to `opts.startScheduler ?? true`. The "does not start timers unless asked" test must FAIL. Restore with Edit.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: the full suite still green — confirm no test started leaking timers.

```bash
git add apps/api/src/analysis/scheduler.ts apps/api/src/analysis/scheduler.test.ts apps/api/src/app.ts apps/api/src/server.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): in-process scheduler for the analysis jobs

Timers start only when the server asks for them, so tests never spawn
background work. The advisory lock is a placeholder for BullMQ and should be
deleted when the queue lands, not kept beside it."
```

---

### Task 7: Read APIs — queries, detail and series

**Files:**
- Create: `apps/api/src/analysis/routes.ts`
- Modify: `apps/api/src/app.ts` (register `analysisRoutes`)
- Test: `apps/api/src/analysis/routes.test.ts`

**Interfaces:**
- Consumes: `requireAppRole` from `../orgs/rbac.js`; `percentileFromHist`, `avgMs` (Task 1)
- Produces: `GET /v1/apps/:id/queries`, `GET /v1/apps/:id/queries/:sig`, `GET /v1/apps/:id/queries/:sig/series`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/routes.test.ts`. Note the gate tests — each must fail if its `preHandler` is weakened:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

async function user(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'Reader' },
  });
  return res.json().accessToken as string;
}
const as = (t: string) => ({ authorization: `Bearer ${t}` });

async function seed() {
  const token = await user(`reader-${Date.now()}@x.io`);
  const org = (
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(token), payload: { name: 'R' } })
  ).json();
  const appRow = (
    await app.inject({
      method: 'POST',
      url: `/v1/orgs/${org.id}/apps`,
      headers: as(token),
      payload: { name: 'r', env: 'production' },
    })
  ).json();
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: appRow.id,
      hash: 'abcdef0123456789',
      signature: 'users.find({email})',
      model: 'users',
      operation: 'find',
      filterShape: [{ key: 'email', op: 'eq' }],
      sortKeys: [],
      stages: [],
      redactedSample: { ms: 20 },
    },
  });
  await app.prisma.queryRollup.create({
    data: {
      signatureId: sig.id,
      bucketHour: new Date(Date.now() - 3_600_000),
      count: 10,
      totalMs: 1000n,
      maxMs: 300,
      hist: [0, 0, 10, 0, 0, 0, 0, 0],
    },
  });
  return { token, appId: appRow.id, sigHash: sig.hash, sigId: sig.id };
}

beforeEach(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe('read APIs', () => {
  it('ranks queries by wasted time and reports the grain used', async () => {
    const { token, appId } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.grain).toBe('hourly');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].totalMs).toBe('1000'); // BigInt -> string
    expect(body.items[0].avgMs).toBe(100);
    expect(body.items[0].p95.basis).toBe('interpolated');
  });

  it('caps limit at 200', async () => {
    const { token, appId } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?limit=9999`,
      headers: as(token),
    });
    expect(res.json().limit).toBe(200);
  });

  it('reads daily rollups for a window longer than seven days', async () => {
    const { token, appId } = await seed();
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries?from=${from}`,
      headers: as(token),
    });
    expect(res.json().grain).toBe('daily');
  });

  it('returns detail with the histogram and the redacted sample', async () => {
    const { token, appId, sigHash } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries/${sigHash}`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().signature).toBe('users.find({email})');
    expect(res.json().hist).toEqual([0, 0, 10, 0, 0, 0, 0, 0]);
    expect(res.json().redactedSample).toEqual({ ms: 20 });
  });

  it('404s a signature belonging to another app', async () => {
    const { token, appId } = await seed();
    const other = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries/${other.sigHash}`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns a series of points', async () => {
    const { token, appId, sigHash } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/queries/${sigHash}/series`,
      headers: as(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(1);
    expect(res.json().points[0].count).toBe(10);
  });

  it.each([
    ['GET', '/queries'],
    ['GET', '/queries/abcdef0123456789'],
    ['GET', '/queries/abcdef0123456789/series'],
  ])('404s a non-member and 401s anonymous on %s %s', async (method, path) => {
    const { appId } = await seed();
    const stranger = await user(`stranger-${Date.now()}@x.io`);

    const outsider = await app.inject({
      method: method as 'GET',
      url: `/v1/apps/${appId}${path}`,
      headers: as(stranger),
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toEqual({ error: 'Not Found' });

    const anon = await app.inject({ method: method as 'GET', url: `/v1/apps/${appId}${path}` });
    expect(anon.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/routes.test.ts`
Expected: FAIL — routes not registered, 404s where 200s are expected.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/analysis/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { requireAppRole } from '../orgs/rbac.js';
import { percentileFromHist, avgMs } from './percentile.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const SEVEN_DAYS_MS = 7 * 86_400_000;

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

export default async function analysisRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.authenticate, requireAppRole('VIEWER')] };

  app.get('/v1/apps/:id/queries', read, async (req) => {
    const q = req.query as { from?: string; to?: string; sort?: string; model?: string; op?: string; limit?: string };
    const { from, to, grain } = resolveWindow(q);
    const limit = clampLimit(q.limit);

    const rows =
      grain === 'hourly'
        ? await app.prisma.$queryRaw<RankRow[]>`
            SELECT s.hash, s.signature, s.model, s.operation,
                   sum(r."count")::int AS count,
                   sum(r."totalMs")    AS "totalMs",
                   max(r."maxMs")::int AS "maxMs",
                   ARRAY(SELECT sum(v)::int FROM unnest(r.hist) WITH ORDINALITY AS u(v,i) GROUP BY i ORDER BY i) AS hist
            FROM "QuerySignature" s
            JOIN "QueryRollup" r ON r."signatureId" = s.id
            WHERE s."appId" = ${req.appId}::uuid
              AND r."bucketHour" BETWEEN ${from} AND ${to}
              AND (${q.model ?? null}::text IS NULL OR s.model = ${q.model ?? null})
              AND (${q.op ?? null}::text IS NULL OR s.operation = ${q.op ?? null})
            GROUP BY s.hash, s.signature, s.model, s.operation
            ORDER BY sum(r."totalMs") DESC
            LIMIT ${limit}
          `
        : await app.prisma.$queryRaw<RankRow[]>`
            SELECT s.hash, s.signature, s.model, s.operation,
                   sum(d."count")::int AS count,
                   sum(d."totalMs")    AS "totalMs",
                   max(d."maxMs")::int AS "maxMs",
                   ARRAY(SELECT sum(v)::int FROM unnest(d.hist) WITH ORDINALITY AS u(v,i) GROUP BY i ORDER BY i) AS hist
            FROM "QuerySignature" s
            JOIN "QueryDailyRollup" d ON d."signatureId" = s.id
            WHERE s."appId" = ${req.appId}::uuid
              AND d.day BETWEEN ${from} AND ${to}
              AND (${q.model ?? null}::text IS NULL OR s.model = ${q.model ?? null})
              AND (${q.op ?? null}::text IS NULL OR s.operation = ${q.op ?? null})
            GROUP BY s.hash, s.signature, s.model, s.operation
            ORDER BY sum(d."totalMs") DESC
            LIMIT ${limit}
          `;

    return {
      grain,
      limit,
      from: from.toISOString(),
      to: to.toISOString(),
      items: rows.map(toItem),
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

function sumHists(hists: number[][]): number[] {
  const out = new Array(8).fill(0) as number[];
  for (const h of hists) for (let i = 0; i < 8; i += 1) out[i] = (out[i] ?? 0) + (h[i] ?? 0);
  return out;
}
```

Modify `apps/api/src/app.ts` to register it alongside the other route plugins:

```ts
await app.register(import('./analysis/routes.js'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/routes.test.ts`
Expected: PASS, 9 tests (6 behaviour + 3 table rows).

- [ ] **Step 5: Verify the gate tests are load-bearing**

Change `requireAppRole('VIEWER')` in `read` to no gate at all (`{ preHandler: [app.authenticate] }`). The three table rows must FAIL on the 404 assertion. Restore with Edit.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/analysis/routes.ts apps/api/src/analysis/routes.test.ts apps/api/src/app.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): ranked queries, signature detail and time series

The window picks its own grain because retention makes the choice unfree —
30 days of hourly rollups do not exist. Every response says which grain
answered it, and totalMs stays a string because it is a BigInt."
```

---

### Task 8: Read APIs — alerts and advice

**Files:**
- Modify: `apps/api/src/analysis/routes.ts`
- Test: `apps/api/src/analysis/alerts.test.ts`

**Interfaces:**
- Consumes: `requireAppRole` (MEMBER for mutations)
- Produces: `GET /v1/apps/:id/alerts`, `PATCH /v1/apps/:id/alerts/:alertId`, `GET /v1/apps/:id/advice`, `PATCH /v1/apps/:id/advice/:adviceId`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/alerts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

async function user(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'A' },
  });
  return { token: res.json().accessToken as string, id: res.json().user.id as string };
}
const as = (t: string) => ({ authorization: `Bearer ${t}` });

async function seed() {
  const owner = await user(`own-${Date.now()}@x.io`);
  const org = (
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner.token), payload: { name: 'A' } })
  ).json();
  const appRow = (
    await app.inject({
      method: 'POST',
      url: `/v1/orgs/${org.id}/apps`,
      headers: as(owner.token),
      payload: { name: 'a', env: 'production' },
    })
  ).json();
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: appRow.id,
      hash: `${Date.now()}`.slice(0, 16).padEnd(16, 'f'),
      signature: 'orders.find({status})',
      model: 'orders',
      operation: 'find',
      filterShape: [{ key: 'status', op: 'eq' }],
      sortKeys: [],
      stages: [],
    },
  });
  const alert = await app.prisma.alert.create({
    data: { signatureId: sig.id, kind: 'regression', details: { latestP95: 300, baselineP95: 100 } },
  });
  const advice = await app.prisma.advice.create({
    data: { signatureId: sig.id, suggestion: { status: 1 }, rationale: 'because' },
  });
  return { owner, orgId: org.id, appId: appRow.id, alertId: alert.id, adviceId: advice.id };
}

beforeEach(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe('alerts and advice', () => {
  it('lists alerts for the app', async () => {
    const { owner, appId } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/alerts`,
      headers: as(owner.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].kind).toBe('regression');
  });

  it('acknowledges an alert', async () => {
    const { owner, appId, alertId } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/alerts/${alertId}`,
      headers: as(owner.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().acknowledgedAt).not.toBeNull();
  });

  it('404s acknowledging an alert belonging to another app', async () => {
    const mine = await seed();
    const theirs = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${mine.appId}/alerts/${theirs.alertId}`,
      headers: as(mine.owner.token),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('sets advice status', async () => {
    const { owner, appId, adviceId } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/advice/${adviceId}`,
      headers: as(owner.token),
      payload: { status: 'APPLIED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPLIED');
  });

  it('rejects an unknown advice status', async () => {
    const { owner, appId, adviceId } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/advice/${adviceId}`,
      headers: as(owner.token),
      payload: { status: 'NONSENSE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a VIEWER on both PATCH routes', async () => {
    const { owner, orgId, appId, alertId, adviceId } = await seed();
    const viewer = await user(`view-${Date.now()}@x.io`);
    await app.prisma.membership.create({
      data: { userId: viewer.id, orgId, role: 'VIEWER' },
    });

    const a = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/alerts/${alertId}`,
      headers: as(viewer.token),
      payload: {},
    });
    expect(a.statusCode).toBe(403);

    const b = await app.inject({
      method: 'PATCH',
      url: `/v1/apps/${appId}/advice/${adviceId}`,
      headers: as(viewer.token),
      payload: { status: 'APPLIED' },
    });
    expect(b.statusCode).toBe(403);

    // and a VIEWER can still read
    const r = await app.inject({
      method: 'GET',
      url: `/v1/apps/${appId}/alerts`,
      headers: as(viewer.token),
    });
    expect(r.statusCode).toBe(200);
    expect(owner.token).not.toBe(viewer.token);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/alerts.test.ts`
Expected: FAIL — routes not registered.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/analysis/routes.ts`, inside `analysisRoutes`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/alerts.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify the gate test is load-bearing**

Change `write`'s `requireAppRole('MEMBER')` to `requireAppRole('VIEWER')`. The "refuses a VIEWER on both PATCH routes" test must FAIL. Restore with Edit.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/analysis/routes.ts apps/api/src/analysis/alerts.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): list and act on alerts and index advice

Reads at VIEWER, state changes at MEMBER — acknowledging an alert and marking
advice applied are workflow acts, not observation. Every URL id is gated
against the caller's app before any write."
```

---

### Task 9: New expensive signatures

**Files:**
- Modify: `apps/api/src/analysis/jobs.ts`
- Test: `apps/api/src/analysis/newExpensive.test.ts`

**Interfaces:**
- Consumes: `JobDeps` (Task 5)
- Produces: `detectNewExpensive(deps: JobDeps): Promise<number>`, called from `runNightlyJobs`

A pure-regression rule misses a deploy that introduced a bad query entirely —
there is no baseline to regress from. This is the rule that catches it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analysis/newExpensive.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { detectNewExpensive } from './jobs.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let appId: string;

async function signature(hash: string, firstSeen: Date, totalMs: bigint) {
  const sig = await app.prisma.querySignature.create({
    data: {
      appId,
      hash,
      signature: `orders.find({${hash}})`,
      model: 'orders',
      operation: 'find',
      filterShape: [],
      sortKeys: [],
      stages: [],
      firstSeen,
      lastSeen: firstSeen,
    },
  });
  await app.prisma.queryRollup.create({
    data: {
      signatureId: sig.id,
      bucketHour: firstSeen,
      count: 100,
      totalMs,
      maxMs: 500,
      hist: [0, 0, 0, 100, 0, 0, 0, 0],
    },
  });
  return sig.id;
}

beforeEach(async () => {
  app = await buildApp();
  const org = await app.prisma.organization.create({
    data: { name: 'NE', slug: `ne-${Date.now()}` },
  });
  const a = await app.prisma.app.create({
    data: { orgId: org.id, name: 'ne', env: 'production' },
  });
  appId = a.id;
});

afterAll(async () => {
  await app?.close();
});

describe('detectNewExpensive', () => {
  const now = new Date('2026-09-20T02:00:00.000Z');
  const recent = new Date('2026-09-19T20:00:00.000Z');
  const old = new Date('2026-09-01T20:00:00.000Z');

  it('alerts a signature first seen within 24 hours that is among the heaviest', async () => {
    await signature('0000000000000001', old, 100n);
    const newId = await signature('0000000000000002', recent, 999_000n);

    const created = await detectNewExpensive({ prisma: app.prisma, now });
    expect(created).toBe(1);

    const alert = await app.prisma.alert.findFirstOrThrow({ where: { signatureId: newId } });
    expect(alert.kind).toBe('new_expensive');
  });

  it('ignores a signature older than 24 hours however heavy', async () => {
    await signature('0000000000000003', old, 999_000n);
    expect(await detectNewExpensive({ prisma: app.prisma, now })).toBe(0);
  });

  it('does not alert the same signature twice', async () => {
    await signature('0000000000000004', recent, 999_000n);
    await detectNewExpensive({ prisma: app.prisma, now });
    const second = await detectNewExpensive({ prisma: app.prisma, now });
    expect(second).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/analysis/newExpensive.test.ts`
Expected: FAIL — `detectNewExpensive` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `apps/api/src/analysis/jobs.ts`:

```ts
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
```

Call it from `runNightlyJobs`, after compaction and **before** pruning:

```ts
  const newExpensive = await detectNewExpensive({ prisma: deps.prisma, now });
```

Add `newExpensive` to `NightlyResult`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/analysis/newExpensive.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the tests are load-bearing**

Remove the `AND "firstSeen" >= ${since}` condition. The "ignores a signature
older than 24 hours" test must FAIL. Restore with Edit.

Remove the `existing` check. The "does not alert the same signature twice"
test must FAIL. Restore.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/analysis/jobs.ts apps/api/src/analysis/newExpensive.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): alert on new expensive signatures

A query that has only ever been slow has no baseline to regress from, so the
regression rule cannot see it. First seen within 24 hours and already in the
app's top ten by wasted time is the shape a bad deploy makes."
```

---

### Task 10: Deploy and verify against the live service

**Files:** none

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Redeploy**

```bash
curl -s -X POST "http://147.93.30.75:3000/api/trpc/services.app.deployService" \
  -H "Authorization: Bearer $EASYPANEL_TOKEN" -H 'content-type: application/json' \
  -d '{"json":{"projectName":"prod","serviceName":"query-analyser-api"}}'
```

A non-empty `message` in the response means the build failed; read the build log in the EasyPanel UI before changing anything.

- [ ] **Step 3: Confirm the service is healthy**

```bash
curl -s https://prod-query-analyser-api.dhql6p.easypanel.host/healthz
```
Expected: `{"status":"ok"}`.

- [ ] **Step 4: Verify a read endpoint end to end**

Sign up, create an org and app, mint a key, ingest a batch (the shape is in
`packages/contract/src/schema.ts` — `app`, `env`, `host`, `sdkVersion`,
`bucket`, `thresholdMs`, `dropped`, `items[]`), then:

```bash
curl -s "$BASE/v1/apps/$APP_ID/queries" -H "authorization: Bearer $TOKEN"
```

Expected: `grain: "hourly"`, one item, `totalMs` as a **string**, `p95.basis`
present.

- [ ] **Step 5: Confirm the scheduler started without taking the service down**

Check the service logs for `analysis job` entries and for the absence of
repeated crash-restarts. The jobs catch their own errors; a failing job must
never stop the API serving requests.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Percentiles, unbounded top bucket, `basis` | 1 |
| Compaction, replace-not-accumulate, element-wise hist | 2 |
| Retention pruning (7 days / 90 days) | 2, 5 |
| Regression rule, factor and count floor | 3 |
| New expensive signatures | 9 |
| Index advice, ESR, exclusions, dismissed stays dismissed | 4, 5 |
| Job seam for BullMQ, advisory lock as placeholder | 5, 6 |
| Detect-before-prune ordering | 5 |
| Scheduler, `startScheduler` flag | 6 |
| Seven read endpoints, grain selection, limits, BigInt string | 7, 8 |
| Auth tests that fail when the gate is removed | 7, 8 |

**Gap found and closed:** the first pass of this plan had no task for the
spec's "new expensive signature" alert. Rather than defer a spec requirement,
it is now Task 9, placed after Task 7 so it can reuse the ranked-by-wasted-time
shape rather than duplicating it.

**Placeholder scan:** none — every code step carries real code.

**Type consistency:** `PercentileResult` (Task 1) is consumed by name in Tasks
5, 7 and 8. `HourPoint` (Task 3) is constructed in Task 5. `JobDeps` (Task 5)
is used in Task 6. `compactDay`/`pruneHourly`/`pruneDaily` (Task 2) are
imported by name in Task 5 and spied on in its test.
