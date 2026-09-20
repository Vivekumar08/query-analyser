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

  // NOTE: kept as the last test in this describe block. Prisma's generated
  // delegate exposes model methods as lazily-synthesized Proxy properties
  // whose own descriptor always reports `value: undefined` regardless of the
  // real bound function underneath. vi.spyOn captures that fake descriptor as
  // "the original", so mockRestore() (here, or automatically via the
  // project's `restoreMocks: true` vitest config) reinstates a dead
  // `findUnique`. Running this test last means no later test in this file
  // depends on the delegate afterwards; each test file gets its own isolated
  // PrismaClient instance, so this does not leak across files.
  it('caches lookups for the TTL, including misses', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });
    const r = new KeyResolver(prisma, 60_000);
    const spy = vi.spyOn(prisma.ingestKey, 'findUnique');
    await r.resolve(k.key);
    await r.resolve(k.key);
    await r.resolve('qa_live_' + '0'.repeat(32));
    await r.resolve('qa_live_' + '0'.repeat(32));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
