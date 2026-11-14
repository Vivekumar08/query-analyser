import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPrisma } from './db.js';
import { resetDb } from './test/db.js';
import { loadConfig } from './config.js';

const prisma = createPrisma(loadConfig().DATABASE_URL);
beforeEach(async () => { await resetDb(prisma); });
afterAll(async () => { await prisma.$disconnect(); });

describe('database', () => {
  it('round-trips an organization', async () => {
    const org = await prisma.organization.create({ data: { name: 'Acme', slug: 'acme' } });
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toMatchObject({ slug: 'acme' });
  });

  it('resetDb empties every table', async () => {
    await prisma.organization.create({ data: { name: 'Acme', slug: 'acme' } });
    await resetDb(prisma);
    expect(await prisma.organization.count()).toBe(0);
  });

  it('enforces the (appId, hash) uniqueness on signatures', async () => {
    const org = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
    const app = await prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
    const data = { appId: app.id, hash: 'h', signature: 's', model: 'M', operation: 'find', filterShape: [], sortKeys: [], stages: [] };
    await prisma.querySignature.create({ data });
    await expect(prisma.querySignature.create({ data })).rejects.toThrow();
  });
  it('rollup histFine must be empty or 14 buckets', async () => {
    const org = await prisma.organization.create({ data: { name: 'H', slug: 'h' } });
    const app = await prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
    const sig = await prisma.querySignature.create({
      data: { appId: app.id, hash: 'h', signature: 's', model: 'M', operation: 'find', filterShape: [], sortKeys: [], stages: [] },
    });
    const insert = (id: string, fine: number[]) => prisma.$executeRaw`
      INSERT INTO "QueryRollup" ("id", "signatureId", "bucketHour", "count", "totalMs", "maxMs", "hist", "histFine")
      VALUES (${id}, ${sig.id}, now(), 1, 1, 1, ARRAY[0,0,0,0,0,0,0,0]::int[], ${fine}::int[])`;
    await expect(insert('r3', [1, 2, 3])).rejects.toThrow(/histFine_length_check|check constraint/i);
    await expect(insert('r0', [])).resolves.toBe(1);
    await expect(insert('r14', new Array(14).fill(0))).resolves.toBe(1);
    const daily = (fine: number[]) => prisma.$executeRaw`
      INSERT INTO "QueryDailyRollup" ("id", "signatureId", "day", "count", "totalMs", "maxMs", "hist", "histFine")
      VALUES (${'d' + fine.length}, ${sig.id}, now(), 1, 1, 1, ARRAY[0,0,0,0,0,0,0,0]::int[], ${fine}::int[])`;
    await expect(daily([1, 2, 3])).rejects.toThrow(/check constraint|histFine_length_check/i);
    await expect(daily([])).resolves.toBe(1);
    await expect(daily(new Array(14).fill(0))).resolves.toBe(1);
  });

  it('defaults the new columns for existing-style rows', async () => {
    const org = await prisma.organization.create({ data: { name: 'D', slug: 'd' } });
    const app = await prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
    expect(app.thresholdMs).toBeNull();
    const sig = await prisma.querySignature.create({
      data: { appId: app.id, hash: 'h', signature: 's', model: 'M', operation: 'find', filterShape: [], sortKeys: [], stages: [] },
    });
    expect(sig).toMatchObject({ orm: null, database: null, sqlText: null, lastErrorCode: null });
    const r = await prisma.queryRollup.create({ data: { signatureId: sig.id, bucketHour: new Date(), count: 1, totalMs: 1n, maxMs: 1, hist: [0, 0, 0, 0, 0, 0, 0, 0] } });
    expect(r).toMatchObject({ errors: 0, histFine: [], minSampleRate: null });
  });

  it('a QuotaDrop row cascades with its app', async () => {
    const org = await prisma.organization.create({ data: { name: 'Q', slug: 'q' } });
    const app = await prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
    await prisma.quotaDrop.create({ data: { appId: app.id, bucketHour: new Date('2026-11-01T10:00:00Z'), droppedNew: 3 } });
    expect(await prisma.quotaDrop.count()).toBe(1);
    await prisma.app.delete({ where: { id: app.id } });
    expect(await prisma.quotaDrop.count()).toBe(0);
  });
  it('the histFine length checks are validated', async () => {
    const rows = await prisma.$queryRaw<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%histFine_length_check' ORDER BY conname`;
    expect(rows).toEqual([
      { conname: 'QueryDailyRollup_histFine_length_check', convalidated: true },
      { conname: 'QueryRollup_histFine_length_check', convalidated: true },
    ]);
  });
});
