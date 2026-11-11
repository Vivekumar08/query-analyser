import { describe, it, expect } from 'vitest';
import { init, shutdown } from '../../sdk/src/index.js';
import { installConnectWrap } from '../../sdk/src/drivers.js';
import { DRIVERS, capture, startMongo } from './harness.js';

/**
 * Overhead benchmark: what command monitoring and the SDK cost per operation
 * on drivers 6 and 7. Skipped unless QA_BENCH=1 (the `bench` script). It
 * asserts nothing about speed; the table is copied into the release notes.
 */
const DOCS = 20_000;
const RUNS = 5;

type Mode = 'off' | 'monitor-only' | 'sdk';
const MODES: Mode[] = ['off', 'monitor-only', 'sdk'];

type Row = {
  driver: string;
  workload: string;
  offMsPerOp: number;
  monitorOnlyMsPerOp: number;
  sdkMsPerOp: number;
  sdkAddedPct: number;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

describe.runIf(process.env.QA_BENCH === '1')('overhead', () => {
  it('reports off / monitor-only / sdk cost per operation', async () => {
    const mongod = await startMongo();
    const uri = mongod.getUri();
    const rows: Row[] = [];
    try {
      for (const { major, mod } of DRIVERS.filter((d) => d.major === 6 || d.major === 7)) {
        const dbName = `bench_mongodb${major}`;

        // Seed once.
        const seeder = new mod.MongoClient(uri);
        await seeder.connect();
        const seedColl = seeder.db(dbName).collection('docs');
        await seedColl.deleteMany({});
        const docs = Array.from({ length: DOCS }, (_, i) => ({ i, s: 'x'.repeat(40), n: i % 7 }));
        for (let k = 0; k < docs.length; k += 5000) await seedColl.insertMany(docs.slice(k, k + 5000));
        const ids = (await seedColl.find({}, { projection: { _id: 1 } }).limit(2000).toArray()).map((d) => d._id);
        await seeder.close();

        const workloads: { name: string; ops: number; run: (db: ReturnType<InstanceType<typeof mod.MongoClient>['db']>) => Promise<void> }[] = [
          {
            name: 'findOne by _id x2000',
            ops: 2000,
            run: async (db) => {
              const c = db.collection('docs');
              for (const id of ids) await c.findOne({ _id: id });
            },
          },
          {
            name: 'find 20k docs toArray x30',
            ops: 30,
            run: async (db) => {
              const c = db.collection('docs');
              for (let k = 0; k < 30; k++) await c.find({}).toArray();
            },
          },
          {
            name: 'insertOne x2000',
            ops: 2000,
            run: async (db) => {
              const c = db.collection('scratch');
              try {
                for (let k = 0; k < 2000; k++) await c.insertOne({ k, s: 'x'.repeat(40) });
              } finally {
                await c.drop().catch(() => {});
              }
            },
          },
        ];

        for (const w of workloads) {
          const result: Record<Mode, number> = { off: 0, 'monitor-only': 0, sdk: 0 };
          for (const mode of MODES) {
            // A fresh client per configuration.
            if (mode === 'sdk') {
              init({ apiKey: 'k', app: `bench-mongodb${major}`, thresholdMs: 100, fetchImpl: capture().fetchImpl });
              installConnectWrap(mod.MongoClient);
            }
            const client = new mod.MongoClient(uri, mode === 'monitor-only' ? { monitorCommands: true } : undefined);
            try {
              await client.connect();
              const db = client.db(dbName);
              await w.run(db); // warm-up
              const samples: number[] = [];
              for (let r = 0; r < RUNS; r++) {
                const t0 = performance.now();
                await w.run(db);
                samples.push((performance.now() - t0) / w.ops);
              }
              result[mode] = median(samples);
            } finally {
              await client.close().catch(() => {});
              if (mode === 'sdk') await shutdown();
            }
          }
          rows.push({
            driver: `mongodb${major}`,
            workload: w.name,
            offMsPerOp: round(result.off),
            monitorOnlyMsPerOp: round(result['monitor-only']),
            sdkMsPerOp: round(result.sdk),
            sdkAddedPct: round(((result.sdk - result.off) / result.off) * 100, 1),
          });
        }
      }
    } finally {
      await mongod.stop();
    }
    console.table(rows);
    expect(rows).toHaveLength(6);
  }, 1_800_000);
});
