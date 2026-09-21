import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { generateKey } from './keys.js';
import * as writer from './writer.js';
import type { FastifyInstance } from 'fastify';
import type { IngestPayload } from '@query-analyser/contract';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function seedKey(opts: { suspended?: boolean; revoked?: boolean } = {}) {
  const org = await app.prisma.organization.create({ data: { name: 'A', slug: 'a', suspendedAt: opts.suspended ? new Date() : null } });
  const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
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
    expect(res.json()).toEqual({ accepted: 2 });
    expect(await app.prisma.querySignature.count({ where: { appId: a.id } })).toBe(2);
  });

  it('accepts a gzip-encoded body', async () => {
    const { key } = await seedKey();
    const res = await post(key, gzipSync(JSON.stringify(payload(3))), { 'content-encoding': 'gzip' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 3 });
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

  it('400s a histogram of the wrong length', async () => {
    const { key } = await seedKey();
    const p = payload();
    p.items[0]!.hist = [1, 2, 3];
    expect((await post(key, p)).statusCode).toBe(400);
  });

  it('429s when the app is over its signature quota', async () => {
    const { app: a, key } = await seedKey();
    // Fill the quota directly.
    await app.prisma.querySignature.createMany({
      data: Array.from({ length: 5000 }, (_, i) => ({
        appId: a.id, hash: `q${i}`.padStart(16, '0'), signature: 's', model: 'M', operation: 'find',
        filterShape: [], sortKeys: [], stages: [],
      })),
    });
    const res = await post(key, payload());
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'signature quota exceeded', limit: 5000 });
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
    expect((await post(key, payload(1))).statusCode).toBe(202);
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
