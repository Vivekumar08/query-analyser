import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createPrisma, type PrismaClient } from '../db.js';
import { resetDb } from '../test/db.js';
import { loadConfig } from '../config.js';

// The data step of the org_created_by migration, read from the migration
// itself so the test runs exactly what deploy runs.
const migrations = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const dir = readdirSync(migrations).find((d) => d.endsWith('_org_created_by'))!;
const sql = readFileSync(join(migrations, dir, 'migration.sql'), 'utf8');
const backfill = sql.slice(sql.indexOf('UPDATE "Organization"'));

let prisma: PrismaClient;
beforeAll(() => { prisma = createPrisma(loadConfig().DATABASE_URL); });
beforeEach(async () => { await resetDb(prisma); });
afterAll(async () => { await prisma.$disconnect(); });

const userRow = (email: string) => prisma.user.create({ data: { email, passwordHash: 'x', name: email } });
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

describe('org_created_by backfill', () => {
  it('is a no-op on an empty database', async () => {
    expect(await prisma.$executeRawUnsafe(backfill)).toBe(0);
  });

  it('fills each org with its earliest OWNER, leaves set values and owner-less orgs alone, and is idempotent', async () => {
    const early = await userRow('e@x.io'); const late = await userRow('l@x.io');
    const member = await userRow('m@x.io'); const preset = await userRow('p@x.io');
    const a = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
    await prisma.membership.createMany({ data: [
      { orgId: a.id, userId: member.id, role: 'MEMBER', createdAt: at(0) },
      { orgId: a.id, userId: late.id, role: 'OWNER', createdAt: at(2) },
      { orgId: a.id, userId: early.id, role: 'OWNER', createdAt: at(1) },
    ] });
    const b = await prisma.organization.create({ data: { name: 'B', slug: 'b', createdById: preset.id } });
    await prisma.membership.create({ data: { orgId: b.id, userId: early.id, role: 'OWNER', createdAt: at(0) } });
    const c = await prisma.organization.create({ data: { name: 'C', slug: 'c' } });
    await prisma.membership.create({ data: { orgId: c.id, userId: member.id, role: 'ADMIN' } });

    expect(await prisma.$executeRawUnsafe(backfill)).toBe(1);
    const createdBy = async (id: string) => (await prisma.organization.findUniqueOrThrow({ where: { id } })).createdById;
    expect(await createdBy(a.id)).toBe(early.id);
    expect(await createdBy(b.id)).toBe(preset.id);
    expect(await createdBy(c.id)).toBeNull();

    expect(await prisma.$executeRawUnsafe(backfill)).toBe(0);
    expect(await createdBy(a.id)).toBe(early.id);
  });
});
