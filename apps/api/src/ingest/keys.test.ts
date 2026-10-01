import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createPrisma } from '../db.js';
import { resetDb } from '../test/db.js';
import { loadConfig } from '../config.js';
import { generateKey, hashKey, KeyResolver } from './keys.js';

const prisma = createPrisma(loadConfig().DATABASE_URL);
beforeEach(async () => { await resetDb(prisma); });
afterAll(async () => { await prisma.$disconnect(); });

async function seedApp() {
  const org = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
  return prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
}

describe('generateKey', () => {
  it('produces qa_live_ + 32 hex, a sha256 hash and a 12-char prefix', () => {
    const k = generateKey();
    expect(k.key).toMatch(/^qa_live_[0-9a-f]{32}$/);
    expect(k.hash).toBe(hashKey(k.key));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.prefix).toBe(k.key.slice(0, 12));
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateKey().key));
    expect(seen.size).toBe(100);
  });
});

describe('KeyResolver', () => {
  it('resolves a stored key to its app and org', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });

    const r = new KeyResolver(prisma);
    expect(await r.resolve(k.key)).toEqual({ keyId: expect.any(String), appId: app.id, orgId: app.orgId, suspended: false });
  });

  it('returns null for an unknown or revoked key', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix, revokedAt: new Date() } });
    const r = new KeyResolver(prisma);
    expect(await r.resolve(k.key)).toBeNull();
    expect(await r.resolve('qa_live_' + 'f'.repeat(32))).toBeNull();
  });

  // NOTE: this test spies on a dedicated, throwaway PrismaClient instance
  // rather than the shared module-level `prisma`. Prisma's generated
  // delegate exposes model methods as lazily-synthesized Proxy properties
  // whose own descriptor always reports `value: undefined` regardless of the
  // real bound function underneath. vi.spyOn captures that fake descriptor as
  // "the original", so mockRestore() (here, or automatically via the
  // project's `restoreMocks: true` vitest config) permanently breaks
  // `findUnique` on that exact client instance. By spying only on a
  // one-off client created and disconnected inside this test, the shared
  // `prisma` client used by every other test is never touched, so this test
  // can sit anywhere in the file without breaking tests that run after it.
  it('caches lookups for the TTL, including misses', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });
    const client = createPrisma(loadConfig().DATABASE_URL);
    try {
      const spy = vi.spyOn(client.ingestKey, 'findUnique');
      const r = new KeyResolver(client, 60_000);
      await r.resolve(k.key);
      await r.resolve(k.key);
      await r.resolve('qa_live_' + '0'.repeat(32));
      await r.resolve('qa_live_' + '0'.repeat(32));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      await client.$disconnect();
    }
  });

  it('reflects a suspended org', async () => {
    const app = await seedApp();
    await prisma.organization.update({ where: { id: app.orgId }, data: { suspendedAt: new Date() } });
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });
    expect(await new KeyResolver(prisma).resolve(k.key)).toMatchObject({ suspended: true });
  });

  it('invalidate() forces the next lookup to hit the database', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });
    const r = new KeyResolver(prisma);
    await r.resolve(k.key);
    await prisma.ingestKey.update({ where: { keyHash: k.hash }, data: { revokedAt: new Date() } });
    expect(await r.resolve(k.key)).not.toBeNull();   // still cached
    r.invalidate(k.hash);
    expect(await r.resolve(k.key)).toBeNull();
  });

  it('bounds cache size to maxEntries by evicting the oldest entry', async () => {
    const maxEntries = 5;
    const r = new KeyResolver(prisma, 60_000, maxEntries);
    for (let i = 0; i < maxEntries + 1; i++) {
      await r.resolve('qa_live_' + i.toString(16).padStart(32, '0'));
    }
    expect(r.size).toBe(maxEntries);
  });

  it('evicts the oldest entry first (FIFO), keeping the most recent cached', async () => {
    const maxEntries = 5;
    const client = createPrisma(loadConfig().DATABASE_URL);
    try {
      const r = new KeyResolver(client, 60_000, maxEntries);
      const keys = Array.from({ length: maxEntries }, (_, i) => 'qa_live_' + i.toString(16).padStart(32, '0'));
      for (const key of keys) {
        await r.resolve(key);
      }
      // one more insert overflows the cache and should evict keys[0] (the oldest)
      const overflowKey = 'qa_live_' + 'f'.repeat(32);
      await r.resolve(overflowKey);
      expect(r.size).toBe(maxEntries);

      const newestKey = keys[keys.length - 1] as string;
      const oldestKey = keys[0] as string;

      const spy = vi.spyOn(client.ingestKey, 'findUnique');
      // the most recently inserted original key should still be cached: no DB call
      await r.resolve(newestKey);
      expect(spy).not.toHaveBeenCalled();

      // the oldest key was evicted: resolving it again hits the DB
      await r.resolve(oldestKey);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await client.$disconnect();
    }
  });
});
