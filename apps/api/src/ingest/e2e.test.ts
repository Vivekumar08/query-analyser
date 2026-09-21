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

beforeAll(async () => {
  app = await buildApp({ logger: false });
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
  it('a real mongoose query lands as a signature and a rollup', async () => {
    const org = await app.prisma.organization.create({ data: { name: 'Kisna', slug: 'kisna' } });
    const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'kisna-web', env: 'test' } });
    const k = generateKey();
    await app.prisma.ingestKey.create({ data: { appId: a.id, keyHash: k.hash, prefix: k.prefix } });

    const Order = mongoose.model(`E2EOrder_${Date.now()}`, new mongoose.Schema({ status: String, total: Number }));
    const analyser = init({
      apiKey: k.key, app: 'kisna-web', env: 'test', thresholdMs: 0,
      endpoint: `${baseUrl}/v1/ingest`, mongoose,
    });

    await Order.find({ status: 'paid', total: { $gte: 10 } }).sort({ total: -1 }).exec();
    await Order.find({ status: 'void', total: { $gte: 99 } }).sort({ total: -1 }).exec();
    await analyser.flush();

    const sigs = await app.prisma.querySignature.findMany({ where: { appId: a.id } });
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ operation: 'find', filterShape: [{ key: 'status', op: 'eq' }, { key: 'total', op: 'range' }] });
    expect(sigs[0]!.model).toMatch(/^E2EOrder_/);
    expect(JSON.stringify(sigs[0]!.redactedSample)).not.toContain('paid');

    const roll = await app.prisma.queryRollup.findFirstOrThrow({ where: { signatureId: sigs[0]!.id } });
    expect(roll.count).toBe(2);
    expect(roll.hist.reduce((x, y) => x + y, 0)).toBe(2);
  });

  it('a revoked key disables the SDK after one 401', async () => {
    await resetDb(app.prisma);
    await shutdown();
    const org = await app.prisma.organization.create({ data: { name: 'K2', slug: 'k2' } });
    const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'x', env: 'test' } });
    const k = generateKey();
    await app.prisma.ingestKey.create({ data: { appId: a.id, keyHash: k.hash, prefix: k.prefix, revokedAt: new Date() } });

    const errors: string[] = [];
    const M = mongoose.model(`E2ERevoked_${Date.now()}`, new mongoose.Schema({ a: String }));
    const analyser = init({ apiKey: k.key, app: 'x', env: 'test', thresholdMs: 0, endpoint: `${baseUrl}/v1/ingest`, mongoose, onError: (e) => errors.push(e.message) });

    await M.find({ a: '1' }).exec();
    await analyser.flush();
    await M.find({ a: '2' }).exec();
    await analyser.flush();

    expect(errors.some((m) => /401|rejected/.test(m))).toBe(true);
    expect(await app.prisma.querySignature.count()).toBe(0);
  });
});
