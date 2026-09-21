import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { init, shutdown } from '@vivekumar08/query-analyser';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { generateKey } from './keys.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mongod: MongoMemoryServer;
let baseUrl: string;
// Counts requests that actually reach POST /v1/ingest, independent of what
// the SDK reports client-side. Registered as a hook (must happen before
// `app.listen`/`ready()` — Fastify refuses new hooks after boot), so it
// observes every ingest request for the lifetime of this file, across both
// tests. Individual tests snapshot/reset it as needed.
let ingestRequestCount = 0;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  app.addHook('onRequest', async (req) => {
    if (req.method === 'POST' && req.url === '/v1/ingest') ingestRequestCount++;
  });
  await resetDb(app.prisma);
  // Listen on a real port: the SDK uses fetch, not inject.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await shutdown();
  await mongoose.disconnect();
  await mongod.stop();
  await app.close();
});

describe('published SDK → this API', () => {
  it('a real mongoose query lands as a signature and a rollup, and no queried value leaks', async () => {
    // Distinctive, unmistakable canaries — cannot appear anywhere in stored
    // rows by coincidence (unlike a short common word such as 'paid').
    const SECRET_EMAIL = 'canary-6f2a9e@leak-detector.invalid';
    const SECRET_NUM = 987654321987;

    const org = await app.prisma.organization.create({ data: { name: 'Kisna', slug: 'kisna' } });
    const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'kisna-web', env: 'test' } });
    const k = generateKey();
    await app.prisma.ingestKey.create({ data: { appId: a.id, keyHash: k.hash, prefix: k.prefix } });

    const Order = mongoose.model(
      `E2EOrder_${Date.now()}`,
      new mongoose.Schema({ status: String, total: Number, email: String }),
    );
    const analyser = init({
      apiKey: k.key, app: 'kisna-web', env: 'test', thresholdMs: 0,
      endpoint: `${baseUrl}/v1/ingest`, mongoose,
    });

    // Filter path: canary as a filter value, plus a sort on the same field.
    await Order.find({ status: SECRET_EMAIL, total: { $gte: SECRET_NUM } }).sort({ total: -1 }).exec();
    await Order.find({ status: 'void', total: { $gte: 99 } }).sort({ total: -1 }).exec();
    // Update-document path: a separate code path from find filters — the
    // canaries here go into the update document ($set), not the filter.
    await Order.updateMany({ status: 'void' }, { $set: { email: SECRET_EMAIL, total: SECRET_NUM } }).exec();
    await analyser.flush();

    const sigs = await app.prisma.querySignature.findMany({ where: { appId: a.id } });
    const rolls = await app.prisma.queryRollup.findMany({ where: { signatureId: { in: sigs.map((s) => s.id) } } });

    const findSig = sigs.find((s) => s.operation === 'find');
    expect(findSig).toBeTruthy();
    expect(findSig).toMatchObject({ filterShape: [{ key: 'status', op: 'eq' }, { key: 'total', op: 'range' }] });
    expect(findSig!.model).toMatch(/^E2EOrder_/);

    const findRoll = rolls.find((r) => r.signatureId === findSig!.id);
    expect(findRoll).toBeTruthy();
    expect(findRoll!.count).toBe(2);
    expect(findRoll!.hist.reduce((x, y) => x + y, 0)).toBe(2);

    // No-leak canary: the *entire* serialised row (signature, filterShape,
    // sortKeys, stages, redactedSample) for every signature and rollup
    // belonging to this app must never contain either secret value. This
    // catches a leak into any field, not just `redactedSample`.
    // Prisma returns BigInt for QueryRollup.totalMs; JSON.stringify throws
    // on a bare BigInt, so serialise it explicitly (see app.ts's own reply
    // serializer for the same issue on the wire).
    const allRowsJson = JSON.stringify({ sigs, rolls }, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(allRowsJson).not.toContain(SECRET_EMAIL);
    expect(allRowsJson).not.toContain(String(SECRET_NUM));
    expect(allRowsJson).not.toContain('paid'); // legacy value, kept out of every field too

    // Positive control: the assertion above cannot pass vacuously by storing
    // nothing — the field *names* used in the filters must still be present
    // somewhere in the stored rows.
    expect(allRowsJson).toContain('status');
    expect(allRowsJson).toContain('total');
  });

  it('a revoked key disables the SDK after one 401 — the SDK actually stops sending', async () => {
    await resetDb(app.prisma);
    await shutdown();
    const org = await app.prisma.organization.create({ data: { name: 'K2', slug: 'k2' } });
    const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'x', env: 'test' } });
    const k = generateKey();
    await app.prisma.ingestKey.create({ data: { appId: a.id, keyHash: k.hash, prefix: k.prefix, revokedAt: new Date() } });

    const errors: string[] = [];
    const M = mongoose.model(`E2ERevoked_${Date.now()}`, new mongoose.Schema({ a: String }));
    const analyser = init({ apiKey: k.key, app: 'x', env: 'test', thresholdMs: 0, endpoint: `${baseUrl}/v1/ingest`, mongoose, onError: (e) => errors.push(e.message) });

    ingestRequestCount = 0; // observe requests from this test only

    await M.find({ a: '1' }).exec();
    await analyser.flush();
    expect(errors.some((m) => /401|rejected/.test(m))).toBe(true);
    // Prove a request actually reached the API before the SDK latched —
    // otherwise the assertions below (0 requests, 0 rows) would be equally
    // true if the SDK had simply never sent anything at all.
    expect(ingestRequestCount).toBe(1);

    await M.find({ a: '2' }).exec();
    await analyser.flush();

    // The latch: a second flush after more queries must NOT produce a
    // second request. Asserting only "zero rows" (as before) cannot
    // distinguish "the SDK stopped sending" from "the SDK kept sending and
    // the API kept rejecting" — both leave zero rows. Counting requests at
    // the server catches the difference.
    expect(ingestRequestCount).toBe(1);
    expect(await app.prisma.querySignature.count()).toBe(0);
  });
});
