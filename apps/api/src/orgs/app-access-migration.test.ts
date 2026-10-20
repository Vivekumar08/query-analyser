import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';

// The data step of the plans_and_app_access migration, read from the migration
// itself so the test runs exactly what deploy runs.
function backfillSql(): string {
  const migrations = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
  const dir = readdirSync(migrations).find((d) => d.endsWith('_plans_and_app_access'));
  if (!dir) throw new Error('plans_and_app_access migration not found');
  const sql = readFileSync(join(migrations, dir, 'migration.sql'), 'utf8');
  const start = sql.indexOf('-- backfill:start');
  const end = sql.indexOf('-- backfill:end');
  if (start < 0 || end < start) throw new Error('backfill markers not found in migration.sql');
  return sql.slice(start, end);
}

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

const backfill = () => app.prisma.$executeRawUnsafe(backfillSql());
const userRow = (email: string) => app.prisma.user.create({ data: { email, passwordHash: 'x', name: email } });

/** org A: OWNER o, ADMIN a, MEMBER m, VIEWER v; apps a1, a2. org B: app b1; m is not in it. */
async function seed() {
  const o = await userRow('o@x.io'); const a = await userRow('a@x.io');
  const m = await userRow('m@x.io'); const v = await userRow('v@x.io');
  const orgA = await app.prisma.organization.create({ data: { name: 'A', slug: 'a' } });
  const orgB = await app.prisma.organization.create({ data: { name: 'B', slug: 'b' } });
  await app.prisma.membership.createMany({ data: [
    { orgId: orgA.id, userId: o.id, role: 'OWNER' },
    { orgId: orgA.id, userId: a.id, role: 'ADMIN' },
    { orgId: orgA.id, userId: m.id, role: 'MEMBER' },
    { orgId: orgA.id, userId: v.id, role: 'VIEWER' },
    { orgId: orgB.id, userId: o.id, role: 'OWNER' },
  ] });
  const a1 = await app.prisma.app.create({ data: { orgId: orgA.id, name: 'Shop', env: 'prod' } });
  const a2 = await app.prisma.app.create({ data: { orgId: orgA.id, name: 'Admin panel', env: 'prod' } });
  const b1 = await app.prisma.app.create({ data: { orgId: orgB.id, name: 'Other', env: 'prod' } });
  return { o, a, m, v, orgA, orgB, a1, a2, b1 };
}

const rows = async () =>
  (await app.prisma.appAccess.findMany({ select: { appId: true, userId: true, role: true } }))
    .map((r) => `${r.appId}|${r.userId}|${r.role}`)
    .sort();

describe('plans_and_app_access backfill', () => {
  it('gives every MEMBER/VIEWER a row for every app in their org with their role; OWNER/ADMIN get none', async () => {
    const s = await seed();
    expect(await backfill()).toBe(4);
    expect(await rows()).toEqual([
      `${s.a1.id}|${s.m.id}|MEMBER`,
      `${s.a2.id}|${s.m.id}|MEMBER`,
      `${s.a1.id}|${s.v.id}|VIEWER`,
      `${s.a2.id}|${s.v.id}|VIEWER`,
    ].sort());
  });

  it('is idempotent', async () => {
    const s = await seed();
    await backfill();
    const before = await rows();
    expect(await backfill()).toBe(0);
    expect(await rows()).toEqual(before);

    await app.prisma.appAccess.delete({ where: { appId_userId: { appId: s.a1.id, userId: s.m.id } } });
    expect(await backfill()).toBe(1);
    expect(await rows()).toEqual(before);
  });

  it('is a no-op on an empty database', async () => {
    expect(await backfill()).toBe(0);
    expect(await app.prisma.appAccess.count()).toBe(0);
  });

  it('refuses an ADMIN or OWNER AppAccess row', async () => {
    const s = await seed();
    await expect(app.prisma.appAccess.create({ data: { appId: s.a1.id, userId: s.a.id, role: 'ADMIN' } })).rejects.toThrow();
    await expect(app.prisma.appAccess.create({ data: { appId: s.a1.id, userId: s.o.id, role: 'OWNER' } })).rejects.toThrow();
    await expect(app.prisma.appAccess.create({ data: { appId: s.a1.id, userId: s.m.id, role: 'MEMBER' } })).resolves.toBeTruthy();
    await expect(app.prisma.appAccess.create({ data: { appId: s.a2.id, userId: s.v.id, role: 'VIEWER' } })).resolves.toBeTruthy();
  });

  it('cascades: deleting an app removes its rows and its invites; deleting a user removes their rows', async () => {
    const s = await seed();
    await backfill();
    const expiresAt = new Date(Date.now() + 86_400_000);
    const appInvite = await app.prisma.invite.create({
      data: { orgId: s.orgA.id, appId: s.a1.id, email: 'n@x.io', role: 'MEMBER', tokenHash: 'h1', expiresAt },
    });
    const orgInvite = await app.prisma.invite.create({
      data: { orgId: s.orgA.id, email: 'w@x.io', role: 'MEMBER', tokenHash: 'h2', expiresAt },
    });
    expect(appInvite.appId).toBe(s.a1.id);
    expect(orgInvite.appId).toBeNull();

    await app.prisma.app.delete({ where: { id: s.a1.id } });
    expect(await rows()).toEqual([`${s.a2.id}|${s.m.id}|MEMBER`, `${s.a2.id}|${s.v.id}|VIEWER`].sort());
    expect(await app.prisma.invite.findUnique({ where: { id: appInvite.id } })).toBeNull();
    expect(await app.prisma.invite.findUnique({ where: { id: orgInvite.id } })).not.toBeNull();

    await app.prisma.user.delete({ where: { id: s.m.id } });
    expect(await rows()).toEqual([`${s.a2.id}|${s.v.id}|VIEWER`]);
  });
});
