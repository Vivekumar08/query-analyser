import { describe, it, expect } from 'vitest';
import { init, shutdown } from '../../sdk/src/index.js';
import { resolvePgClients } from '../../sdk/src/drivers.js';
import { installPgPoolWrap, installPgWrap } from '../../sdk/src/integrations/pg.js';
import { pgCoversAdapter } from '../../sdk/src/integrations/prisma.js';
import { sqlRuntime } from '../../sdk/src/sql/context.js';
import { createThrowawayDb, pgAvailable } from '../../sdk/src/__tests__/pg-db.js';
import { capture, itemsOf, sum, PGS } from './pg-harness.js';
import { FIXTURES, load, pushSchema, resolverAt } from './prisma-harness.js';

/**
 * SQL overhead benchmark: what pg and Prisma capture cost per operation. Skipped unless QA_BENCH=1
 * (the `bench` script). It asserts nothing about speed; the table is copied into the release notes.
 *
 * Each stack gets its own throwaway database. Prisma stacks run on the adapter path, wired as init()
 * wires a resolved copy (see prisma-suite.ts), so the numbers are what users get.
 */
const ROWS = 1000;
const RUNS = 5;
const WARMUP = 300;
const PG_OPS = 5000;
const PRISMA_OPS = 3000;

type Mode = 'off' | 'rate1' | 'rate01';
const MODES: { mode: Mode; rate: number }[] = [
  { mode: 'off', rate: 0 },
  { mode: 'rate1', rate: 1 },
  { mode: 'rate01', rate: 0.1 },
];

type Row = {
  stack: string;
  workload: string;
  offUsPerOp: number;
  sdkRate1UsPerOp: number;
  sdkRate01UsPerOp: number;
  addedPctRate1: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

/** What a stack runs: `open` builds a fresh client, `call` does one operation. */
interface Stack {
  stack: string;
  workload: string;
  ops: number;
  /** The pg module whose classes the SDK wraps, and where the app resolves from (Prisma fixtures). */
  pg: any;
  appDir?: string;
  db: { url: string; name: string; drop(): Promise<void> };
  open(): Promise<{ call(i: number): Promise<unknown>; close(): Promise<void> }>;
}

/** The own `query` descriptors of every class the SDK may wrap, to prove shutdown() restored them. */
function snapshot(pg: any): unknown[] {
  return [pg.Client, pg.Pool].map((C: any) => Object.getOwnPropertyDescriptor(C.prototype, 'query'));
}

async function measure(s: Stack, rate: number | null): Promise<number> {
  const before = snapshot(s.pg);
  const cap = capture();
  if (rate !== null) {
    const a = init({
      apiKey: 'k', app: `bench-${s.stack}`, thresholdMs: 100, sql: { sampleRate: rate },
      fetchImpl: cap.fetchImpl, pg: s.pg,
    });
    void a;
    const r = resolvePgClients(s.pg, s.appDir ? { appEntry: resolverAt(s.appDir) } : undefined);
    for (const C of r.clients) installPgWrap(C);
    for (const P of r.pools) installPgPoolWrap(P);
    const rt = sqlRuntime();
    rt.prismaAdapterResolved = r.adapterResolved;
    rt.pgCoversPrismaAdapter = pgCoversAdapter(r.adapterResolved, r.adapterPg);
  }
  const h = await s.open();
  try {
    for (let i = 0; i < WARMUP; i++) await h.call(i);
    const samples: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const t0 = performance.now();
      for (let i = 0; i < s.ops; i++) await h.call(i);
      samples.push(((performance.now() - t0) * 1000) / s.ops);
    }
    return median(samples);
  } finally {
    await h.close().catch(() => {});
    if (rate !== null) {
      await shutdown();
      // Guard: at rate 1 the SDK must have counted at least every measured call, or the numbers mean nothing.
      const counted = sum(itemsOf(cap.bodies).map((i) => i.count));
      if (rate === 1 && counted < s.ops * RUNS) throw new Error(`sql-overhead: ${s.stack} counted ${counted} of ${s.ops * RUNS}+ statements`);
      const after = snapshot(s.pg);
      if (after.some((d, i) => (d as any)?.value !== (before[i] as any)?.value)) {
        throw new Error(`sql-overhead: shutdown() did not restore pg prototypes for ${s.stack}`);
      }
    }
  }
}

describe.runIf(process.env.QA_BENCH === '1')('sql overhead', () => {
  it('reports off / sdk at rate 1 / sdk at rate 0.1 per operation', async () => {
    const avail = await pgAvailable();
    if (!avail.ok) throw new Error(`sql-overhead: no reachable Postgres (${avail.reason})`);
    const dbs: Stack['db'][] = [];
    const rows: Row[] = [];
    try {
      const stacks: Stack[] = [];

      // pg 8.23, a plain pool over a table of 1,000 rows.
      {
        const db = await createThrowawayDb('bench_pg823');
        dbs.push(db);
        const pg = PGS.find((p) => p.alias === 'pg823')!.mod as any;
        const seeder = new pg.Client({ connectionString: db.url });
        await seeder.connect();
        await seeder.query('CREATE TABLE t (id int primary key, v text NOT NULL)');
        await seeder.query(`INSERT INTO t SELECT g, repeat('x', 40) FROM generate_series(1, ${ROWS}) g`);
        await seeder.end();
        stacks.push({
          stack: 'pg823', workload: `pool.query by id x${PG_OPS}`, ops: PG_OPS, pg, db,
          async open() {
            const pool = new pg.Pool({ connectionString: db.url, max: 4 });
            return {
              call: (i) => pool.query('SELECT * FROM t WHERE id = $1', [(i % ROWS) + 1]),
              close: () => pool.end(),
            };
          },
        });
      }

      // Prisma 7.10, 6.19 and 5.22 on the adapter path.
      for (const name of ['p710', 'p619', 'p522']) {
        const fx = FIXTURES.find((f) => f.name === name)!;
        const L = load(fx);
        const db = await createThrowawayDb(`bench_${name}`);
        dbs.push(db);
        await pushSchema(fx, db.url);
        const seeder = new L.pg.Client({ connectionString: db.url });
        await seeder.connect();
        await seeder.query(`INSERT INTO "User" (email, name) SELECT 'u' || g || '@x.test', 'n' FROM generate_series(1, ${ROWS}) g`);
        const ids: number[] = (await seeder.query('SELECT id FROM "User" ORDER BY id')).rows.map((r: any) => r.id);
        await seeder.end();
        stacks.push({
          stack: name, workload: `user.findUnique x${PRISMA_OPS}`, ops: PRISMA_OPS, pg: L.pg, appDir: fx.dir, db,
          async open() {
            const pool = new L.pg.Pool({ connectionString: db.url, max: 4 });
            const p = new L.PrismaClient({ adapter: new L.PrismaPg(pool) });
            await p.$connect();
            return {
              call: (i) => p.user.findUnique({ where: { id: ids[i % ids.length]! } }),
              close: async () => { await p.$disconnect(); await pool.end(); },
            };
          },
        });
      }

      for (const s of stacks) {
        const r: Record<Mode, number> = { off: 0, rate1: 0, rate01: 0 };
        for (const { mode, rate } of MODES) r[mode] = await measure(s, mode === 'off' ? null : rate);
        rows.push({
          stack: s.stack,
          workload: s.workload,
          offUsPerOp: round(r.off),
          sdkRate1UsPerOp: round(r.rate1),
          sdkRate01UsPerOp: round(r.rate01),
          addedPctRate1: round(((r.rate1 - r.off) / r.off) * 100),
        });
      }
    } finally {
      await shutdown().catch(() => {});
      await Promise.allSettled(dbs.map((d) => d.drop()));
    }
    console.table(rows);
    expect(rows).toHaveLength(4);
  }, 3_600_000);
});
