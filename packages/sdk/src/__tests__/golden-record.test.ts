import { describe, it, expect, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { init, shutdown } from '../index.js';
import { GOLDEN_CASES, GOLDEN_FIELDS, buildGoldenModels, seedGolden } from './golden-cases.js';

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

describe.runIf(process.env.QA_RECORD_GOLDEN === '1')('record 0.2 golden output', () => {
  it('records one 0.2 item per golden case', async () => {
    const mongod = await MongoMemoryServer.create();
    try {
      const { bodies, fetchImpl } = capture();
      const a = init({ apiKey: 'k', app: 'golden', thresholdMs: 0, mongoose, fetchImpl });
      const conn = await mongoose.createConnection(mongod.getUri()).asPromise();
      const m = buildGoldenModels(conn);
      const ids = await seedGolden(m);
      await a.flush();
      bodies.length = 0;

      const cases: Record<string, Record<string, unknown>> = {};
      for (const c of GOLDEN_CASES) {
        bodies.length = 0;
        await c.run(m, ids);
        await a.flush();
        const items = bodies.flatMap((b) => JSON.parse(b).items as Record<string, unknown>[]);
        expect(items, c.name).toHaveLength(1);
        const picked: Record<string, unknown> = {};
        for (const f of GOLDEN_FIELDS) picked[f] = items[0]![f];
        cases[c.name] = picked;
      }
      await conn.close();
      await shutdown();
      const out = { sdkVersion: '0.2.0', mongoose: mongoose.version, cases };
      writeFileSync(fileURLToPath(new URL('./golden-0.2.json', import.meta.url)), JSON.stringify(out, null, 2) + '\n');
    } finally {
      await mongod.stop();
    }
  }, 120_000);
});
