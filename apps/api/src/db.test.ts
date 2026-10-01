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
});
