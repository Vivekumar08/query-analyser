import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { generateKey } from './keys.js';
import * as writer from './writer.js';
import type { FastifyInstance } from 'fastify';
import { encryptSample, generateSampleKeyPair, type IngestPayload } from '@query-analyser/contract';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function seedKey(opts: { suspended?: boolean; revoked?: boolean; samplePublicKey?: string } = {}) {
  const org = await app.prisma.organization.create({ data: { name: 'A', slug: 'a', suspendedAt: opts.suspended ? new Date() : null } });
  const a = await app.prisma.app.create({
    data: {
      orgId: org.id, name: 'web', env: 'prod',
      ...(opts.samplePublicKey ? { samplePublicKey: opts.samplePublicKey, sampleKeyWrapped: { v: 1 } } : {}),
    },
  });
  const k = generateKey();
  await app.prisma.ingestKey.create({ data: { appId: a.id, keyHash: k.hash, prefix: k.prefix, revokedAt: opts.revoked ? new Date() : null } });
  return { app: a, key: k.key };
}

const payload = (n = 1): IngestPayload => ({
  app: 'web', env: 'prod', host: 'h', sdkVersion: '0.1.0', bucket: '2026092014', thresholdMs: 100, dropped: 0,
  items: Array.from({ length: n }, (_, i) => ({
    signature: `S${i}`, hash: i.toString(16).padStart(16, '0'), model: 'M', operation: 'find',
    filterShape: [], sortKeys: [], stages: [], count: 1, totalMs: 120, maxMs: 120, lastMs: 120, lastTs: 1,
    hist: [0, 1, 0, 0, 0, 0, 0, 0], sample: null,
  })),
});

const post = (key: string | null, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST', url: '/v1/ingest',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    payload: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

describe('POST /v1/ingest', () => {
  it('accepts a valid batch and writes it', async () => {
    const { app: a, key } = await seedKey();
    const res = await post(key, payload(2));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2, droppedNew: 0 });
    expect(await app.prisma.querySignature.count({ where: { appId: a.id } })).toBe(2);
  });

  it('accepts a 0.3 batch with source and collection and stores them', async () => {
    const { app: a, key } = await seedKey();
    const body = payload(1);
    body.items[0] = { ...body.items[0]!, source: 'mongodb', collection: 'orders' };
    const res = await post(key, body);
    expect(res.statusCode).toBe(202);
    const row = await app.prisma.querySignature.findFirstOrThrow({ where: { appId: a.id } });
    expect(row).toMatchObject({ source: 'mongodb', collection: 'orders' });
  });

  it('accepts a gzip-encoded body', async () => {
    const { key } = await seedKey();
    const res = await post(key, gzipSync(JSON.stringify(payload(3))), { 'content-encoding': 'gzip' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 3, droppedNew: 0 });
  });

  it('stamps lastUsedAt on the key', async () => {
    const { key } = await seedKey();
    await post(key, payload());
    const row = await app.prisma.ingestKey.findFirstOrThrow();
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('401s without a key', async () => {
    expect((await post(null, payload())).statusCode).toBe(401);
  });

  it('401s a malformed key', async () => {
    expect((await post('nope', payload())).statusCode).toBe(401);
  });

  it('401s an unknown key', async () => {
    expect((await post('qa_live_' + 'f'.repeat(32), payload())).statusCode).toBe(401);
  });

  it('401s a revoked key', async () => {
    const { key } = await seedKey({ revoked: true });
    expect((await post(key, payload())).statusCode).toBe(401);
  });

  it('403s a suspended org', async () => {
    const { key } = await seedKey({ suspended: true });
    expect((await post(key, payload())).statusCode).toBe(403);
  });

  it('400s an invalid body with zod issues', async () => {
    const { key } = await seedKey();
    const bad = { ...payload(), bucket: 'nope' };
    const res = await post(key, bad);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid payload', issues: expect.any(Array) });
  });

  it('400s a thresholdMs over one hour and writes nothing', async () => {
    const { app: a, key } = await seedKey();
    const res = await post(key, { ...payload(1), thresholdMs: 1e10 });
    expect(res.statusCode).toBe(400);
    expect(await app.prisma.querySignature.count({ where: { appId: a.id } })).toBe(0);
  });

  it('400s a histogram of the wrong length', async () => {
    const { key } = await seedKey();
    const p = payload();
    p.items[0]!.hist = [1, 2, 3];
    expect((await post(key, p)).statusCode).toBe(400);
  });

  const fillQuota = (appId: string, n: number) =>
    app.prisma.querySignature.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        appId, hash: `q${i}`.padStart(16, '0'), signature: 's', model: 'M', operation: 'find',
        filterShape: [], sortKeys: [], stages: [],
      })),
    });

  it('at the quota, drops new shapes, answers 202 with droppedNew and records the drop', async () => {
    const { app: a, key } = await seedKey();
    await fillQuota(a.id, 5000);
    const res = await post(key, payload(3));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 0, droppedNew: 3 });
    // Recorded under the server's current hour, not the payload's bucket.
    const drop = await app.prisma.quotaDrop.findFirstOrThrow({ where: { appId: a.id } });
    expect(drop.droppedNew).toBe(3);
    expect(await app.prisma.querySignature.count({ where: { appId: a.id } })).toBe(5000);
  });

  it('Review Focus: a 6,000-shape app stores every known item and the new ones up to the quota', async () => {
    const { app: a, key } = await seedKey();
    await fillQuota(a.id, 4990);
    const known = Array.from({ length: 50 }, (_, i) => `q${i}`.padStart(16, '0'));
    const body = payload(1050);
    body.items.forEach((it, i) => { it.hash = i < 50 ? known[i]! : `n${i}`.padStart(16, '0'); });
    const res = await post(key, body);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 60, droppedNew: 990 });
    const hourly = (h: string) => app.prisma.queryRollup.count({ where: { signature: { appId: a.id, hash: h } } });
    expect(await app.prisma.queryRollup.count({ where: { signature: { appId: a.id, hash: { in: known } } } })).toBe(50);
    const newHashes = body.items.slice(50).map((i) => i.hash);
    const stored = await app.prisma.querySignature.findMany({ where: { appId: a.id, hash: { in: newHashes } }, select: { hash: true } });
    expect(stored.map((r) => r.hash).sort()).toEqual(newHashes.slice(0, 10).sort());
    expect(await hourly(newHashes[10]!)).toBe(0);
    const dropRow = () => app.prisma.quotaDrop.findFirstOrThrow({ where: { appId: a.id } });
    expect((await dropRow()).droppedNew).toBe(990);
    const again = await post(key, body);
    expect(again.json()).toEqual({ accepted: 60, droppedNew: 990 });
    expect((await dropRow()).droppedNew).toBe(1980);
    expect(await app.prisma.querySignature.count({ where: { appId: a.id } })).toBe(5000);
  });

  it('a 0.3 Mongo payload at the quota is partially accepted the same way', async () => {
    const { app: a, key } = await seedKey();
    await fillQuota(a.id, 4999);
    const body = payload(3);
    body.sdkVersion = '0.3.0';
    body.items.forEach((it, i) => { it.hash = `m${i}`.padStart(16, '0'); it.source = 'mongodb'; it.collection = 'orders'; });
    const res = await post(key, body);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, droppedNew: 2 });
    expect(await app.prisma.querySignature.count({ where: { appId: a.id } })).toBe(5000);
  });

  it('two batches racing at the boundary do not push the count past the quota', async () => {
    const { app: a, key } = await seedKey();
    await fillQuota(a.id, 4990);
    const mk = (prefix: string) => {
      const b = payload(10);
      b.items.forEach((it, i) => { it.hash = `${prefix}${i}`.padStart(16, '0'); });
      return b;
    };
    const [r1, r2] = await Promise.all([post(key, mk('x')), post(key, mk('y'))]);
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    const [b1, b2] = [r1.json(), r2.json()];
    expect(b1.accepted + b2.accepted).toBe(10);
    expect(b1.droppedNew + b2.droppedNew).toBe(10);
    expect(await app.prisma.querySignature.count({ where: { appId: a.id } })).toBe(5000);
    const drops = await app.prisma.quotaDrop.findMany({ where: { appId: a.id } });
    expect(drops.reduce((n, d) => n + d.droppedNew, 0)).toBe(10);
    expect(app.ingestStats.droppedNew).toBeGreaterThanOrEqual(10);
  });

  it('records the drop under the server hour, not a client-supplied future bucket', async () => {
    const { app: a, key } = await seedKey();
    await fillQuota(a.id, 5000);
    const body = payload(2);
    body.bucket = '2099010100';
    const before = Date.now();
    expect((await post(key, body)).json()).toEqual({ accepted: 0, droppedNew: 2 });
    const rows = await app.prisma.quotaDrop.findMany({ where: { appId: a.id } });
    expect(rows).toHaveLength(1);
    expect(Math.abs(rows[0]!.bucketHour.getTime() - before)).toBeLessThan(2 * 3_600_000);
  });

  it('still accepts a batch of already-known signatures at quota', async () => {
    const { app: a, key } = await seedKey();
    await post(key, payload(1));
    await app.prisma.querySignature.createMany({
      data: Array.from({ length: 4999 }, (_, i) => ({
        appId: a.id, hash: `q${i}`.padStart(16, '0'), signature: 's', model: 'M', operation: 'find',
        filterShape: [], sortKeys: [], stages: [],
      })),
    });
    const res = await post(key, payload(1));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, droppedNew: 0 });
  });

  it('413s a body over the limit', async () => {
    const { key } = await seedKey();
    const huge = payload(1);
    huge.items[0]!.sample = { x: 'y'.repeat(3 * 1024 * 1024) };
    expect((await post(key, huge)).statusCode).toBe(413);
  });

  it('415s an unsupported content-encoding', async () => {
    const { key } = await seedKey();
    const res = await post(key, payload(1), { 'content-encoding': 'br' });
    expect(res.statusCode).toBe(415);
  });

  it('does not leak raw Postgres constraint text when writeBatch throws a database error', async () => {
    const { key } = await seedKey();
    const spy = vi.spyOn(writer, 'writeBatch').mockRejectedValueOnce(
      Object.assign(new Error('new row for relation "QueryRollup" violates check constraint "QueryRollup_hist_check"'), {
        code: 'P2010',
        name: 'PrismaClientKnownRequestError',
      }),
    );
    const res = await post(key, payload(1));
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toEqual({ error: 'Internal Server Error' });
    expect(JSON.stringify(body)).not.toMatch(/constraint|QueryRollup|relation/i);
    spy.mockRestore();
  });
});

describe('POST /v1/ingest — encrypted samples', () => {
  async function withEnvelope(publicKey: string) {
    const body = payload(1);
    body.items[0]!.encryptedSample = await encryptSample(publicKey, '{"filter":{"email":"a@b.c"}}');
    return body;
  }

  it('stores the envelope for an app with a sample key', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const { app: a, key } = await seedKey({ samplePublicKey: publicKey });
    const body = await withEnvelope(publicKey);
    expect((await post(key, body)).statusCode).toBe(202);
    const sig = await app.prisma.querySignature.findFirstOrThrow({ where: { appId: a.id } });
    expect(sig.encryptedSample).toEqual(body.items[0]!.encryptedSample);
  });

  it('does not store the envelope for an app without a sample key', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const { app: a, key } = await seedKey();
    expect((await post(key, await withEnvelope(publicKey))).statusCode).toBe(202);
    const sig = await app.prisma.querySignature.findFirstOrThrow({ where: { appId: a.id } });
    expect(sig.encryptedSample).toBeNull();
  });

  it('400s an oversized envelope', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const { key } = await seedKey({ samplePublicKey: publicKey });
    const body = await withEnvelope(publicKey);
    body.items[0]!.encryptedSample = { ...body.items[0]!.encryptedSample!, ct: 'A'.repeat(24_004) };
    expect((await post(key, body)).statusCode).toBe(400);
  });
});

describe('POST /v1/ingest — rate limiting', () => {
  // The production default (600/min) is too slow to exercise directly in a
  // test. `rateLimitMax` (a test-only BuildOptions field, never lowered in
  // production — see app.ts) drives a dedicated app instance with a tiny
  // window so we can prove the limiter actually engages, keyed on the
  // request IP rather than on attacker-controlled request content.
  let limitedApp: FastifyInstance;
  beforeAll(async () => { limitedApp = await buildApp({ logger: false, rateLimitMax: 3 }); });
  afterAll(async () => { await limitedApp.close(); });

  it('429s a single source once it exceeds the per-minute limit, even when every request carries a fresh unknown key', async () => {
    // Every request below uses a distinct, never-seen Authorization value.
    // If the limiter were keyed on request content (the bug this fixes),
    // each request would land in its own bucket and this would 401 forever
    // without ever 429ing. Keying on `req.ip` (all `inject()` calls share
    // one socket address) means the shared bucket fills regardless.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await limitedApp.inject({
        method: 'POST', url: '/v1/ingest',
        headers: { 'content-type': 'application/json', authorization: `Bearer qa_live_${i.toString().padStart(32, '0')}` },
        payload: JSON.stringify(payload(1)),
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
  });
});
