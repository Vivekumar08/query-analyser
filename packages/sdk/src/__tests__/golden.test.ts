import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { init, shutdown, type Analyser } from '../index.js';
import { GOLDEN_CASES, GOLDEN_FIELDS, buildGoldenModels, seedGolden, type GoldenIds, type GoldenModels } from './golden-cases.js';

// Recorded from SDK 0.2 (mongoose middleware) in Task 1. Never edited to make
// this test pass: a mismatch here is a mapping bug in the driver path.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./golden-0.2.json', import.meta.url)), 'utf8'),
) as { sdkVersion: string; mongoose: string; cases: Record<string, Record<string, unknown>> };

function capture() {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const isGzipped = (init?.headers as Record<string, string> | undefined)?.['Content-Encoding'] === 'gzip';
    const body = init?.body;
    if (isGzipped && body) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as unknown as Uint8Array);
      bodies.push(gunzipSync(buf).toString('utf8'));
    } else {
      bodies.push(typeof body === 'string' ? body : String(body));
    }
    return new Response('{}', { status: 202 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const pick = (fields: readonly string[]) => (item: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = item[f];
  return out;
};

describe("all 35 mongoose 8 golden cases keep 0.2's exact hash, shape and sample", () => {
  let mongod: MongoMemoryServer;
  let conn: mongoose.Connection;
  let analyser: Analyser;
  let models: GoldenModels;
  let ids: GoldenIds;
  const { bodies, fetchImpl } = capture();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    // init() BEFORE the connection exists: zero-setup, no monitorCommands.
    analyser = init({ apiKey: 'k', app: 'golden', thresholdMs: 0, mongoose, fetchImpl });
    conn = await mongoose.createConnection(mongod.getUri()).asPromise();
    models = buildGoldenModels(conn);
    ids = await seedGolden(models);
    await analyser.flush();
    bodies.length = 0;
  }, 60_000);

  afterAll(async () => {
    await shutdown();
    await conn?.close();
    await mongod?.stop();
  });

  it.each(GOLDEN_CASES.map((c) => [c.name, c] as const))('%s', async (name, c) => {
    bodies.length = 0;
    await c.run(models, ids);
    await analyser.flush();
    const items = bodies.flatMap((b) => JSON.parse(b).items as Record<string, unknown>[]);
    expect(items.map(pick(GOLDEN_FIELDS))).toEqual([fixture.cases[name]]);
  });

  it('the fixture has all 35 cases', () => {
    expect(Object.keys(fixture.cases)).toHaveLength(35);
    expect(GOLDEN_CASES).toHaveLength(35);
  });
});
