import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { resetDb } from './test/db.js';
import { isForeignKeyViolation } from './db-errors.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
const MISSING = '00000000-0000-0000-0000-000000000000';

// Real errors from the real driver adapter, so the shapes can't drift from
// what the code sees: a raw query wraps the FK failure as P2010 with the
// SQLSTATE in meta.driverAdapterError, a model query may report it otherwise.
describe('isForeignKeyViolation', () => {
  it('recognises a foreign-key failure from a raw query (writeBatch\'s statements)', async () => {
    const sig = await caught(app.prisma.$executeRaw`
      INSERT INTO "QuerySignature" (id, "appId", hash, signature, model, operation, "filterShape", "sortKeys", stages)
      VALUES (gen_random_uuid()::text, ${MISSING}, 'h', 's', 'M', 'find', '[]', '[]', '{}')`);
    expect(isForeignKeyViolation(sig)).toBe(true);
    const rollup = await caught(app.prisma.$executeRaw`
      INSERT INTO "QueryRollup" (id, "signatureId", "bucketHour", count, "totalMs", "maxMs", hist)
      VALUES (gen_random_uuid()::text, ${MISSING}, now(), 1, 1, 1, '{0,0,0,0,0,0,0,0}')`);
    expect(isForeignKeyViolation(rollup)).toBe(true);
  });

  it('recognises one from a model query (the jobs\' writes)', async () => {
    const e = await caught(app.prisma.alert.create({ data: { signatureId: MISSING, kind: 'regression', details: {} } }));
    expect(isForeignKeyViolation(e)).toBe(true);
  });

  it('is false for other errors', async () => {
    const org = await app.prisma.organization.create({ data: { name: 'A', slug: 'a' } });
    const dup = await caught(app.prisma.organization.create({ data: { name: 'B', slug: org.slug } }));
    expect(isForeignKeyViolation(dup)).toBe(false);
    const raw = await caught(app.prisma.$executeRaw`SELECT 1/0`);
    expect(isForeignKeyViolation(raw)).toBe(false);
    expect(isForeignKeyViolation(new Error('x'))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
  });
});
