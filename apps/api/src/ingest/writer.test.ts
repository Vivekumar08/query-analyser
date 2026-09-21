import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createPrisma } from '../db.js';
import { resetDb } from '../test/db.js';
import { loadConfig } from '../config.js';
import { writeBatch, bucketToDate } from './writer.js';
import type { IngestPayload, IngestItem } from '@query-analyser/contract';

const prisma = createPrisma(loadConfig().DATABASE_URL);
beforeEach(async () => { await resetDb(prisma); });
afterAll(async () => { await prisma.$disconnect(); });

async function seedApp() {
  const org = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
  return prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
}

function item(over: Partial<IngestItem> = {}): IngestItem {
  return {
    signature: 'Order.find(status:eq)', hash: 'a'.repeat(16), model: 'Order', operation: 'find',
    filterShape: [{ key: 'status', op: 'eq' }], sortKeys: [], stages: [],
    count: 3, totalMs: 600, maxMs: 400, lastMs: 120, lastTs: 1758378000000,
    hist: [0, 2, 1, 0, 0, 0, 0, 0], sample: { filter: { status: '<string>' } },
    ...over,
  };
}

function payload(items: IngestItem[], bucket = '2026092014'): IngestPayload {
  return { app: 'web', env: 'prod', host: 'h', sdkVersion: '0.1.0', bucket, thresholdMs: 100, dropped: 0, items };
}

describe('bucketToDate', () => {
  it('parses YYYYMMDDHH as UTC', () => {
    expect(bucketToDate('2026092014').toISOString()).toBe('2026-09-20T14:00:00.000Z');
  });
});

describe('writeBatch', () => {
  it('creates a signature and a rollup for a new shape', async () => {
    const app = await seedApp();
    const res = await writeBatch(prisma, app.id, payload([item()]));
    expect(res).toEqual({ signatures: 1, rollups: 1 });

    const sig = await prisma.querySignature.findUniqueOrThrow({ where: { appId_hash: { appId: app.id, hash: 'a'.repeat(16) } } });
    expect(sig).toMatchObject({ model: 'Order', operation: 'find', stages: [] });
    expect(sig.redactedSample).toEqual({ filter: { status: '<string>' } });

    const roll = await prisma.queryRollup.findUniqueOrThrow({ where: { signatureId_bucketHour: { signatureId: sig.id, bucketHour: bucketToDate('2026092014') } } });
    expect(roll).toMatchObject({ count: 3, maxMs: 400, hist: [0, 2, 1, 0, 0, 0, 0, 0] });
    expect(roll.totalMs).toBe(600n);
  });

  it('accumulates a second batch into the same hour: count and total add, max is greatest, hist is element-wise', async () => {
    const app = await seedApp();
    await writeBatch(prisma, app.id, payload([item()]));
    await writeBatch(prisma, app.id, payload([item({ count: 2, totalMs: 1000, maxMs: 900, hist: [0, 0, 0, 1, 1, 0, 0, 0] })]));

    const sig = await prisma.querySignature.findFirstOrThrow({ where: { appId: app.id } });
    const roll = await prisma.queryRollup.findFirstOrThrow({ where: { signatureId: sig.id } });
    expect(roll).toMatchObject({ count: 5, maxMs: 900, hist: [0, 2, 1, 1, 1, 0, 0, 0] });
    expect(roll.totalMs).toBe(1600n);
  });

  it('keeps separate rows per hour', async () => {
    const app = await seedApp();
    await writeBatch(prisma, app.id, payload([item()], '2026092014'));
    await writeBatch(prisma, app.id, payload([item()], '2026092015'));
    expect(await prisma.queryRollup.count()).toBe(2);
  });

  it('updates lastSeen and the sample on an existing signature but keeps firstSeen', async () => {
    const app = await seedApp();
    await writeBatch(prisma, app.id, payload([item()]));
    const before = await prisma.querySignature.findFirstOrThrow({ where: { appId: app.id } });
    await new Promise((r) => setTimeout(r, 20));
    await writeBatch(prisma, app.id, payload([item({ sample: { filter: { status: '<string>', v: '<number>' } } })]));
    const after = await prisma.querySignature.findFirstOrThrow({ where: { appId: app.id } });
    expect(after.firstSeen.getTime()).toBe(before.firstSeen.getTime());
    expect(after.lastSeen.getTime()).toBeGreaterThan(before.lastSeen.getTime());
    expect(after.redactedSample).toEqual({ filter: { status: '<string>', v: '<number>' } });
  });

  it('writes many distinct signatures in one batch', async () => {
    const app = await seedApp();
    const items = Array.from({ length: 200 }, (_, i) => item({ hash: i.toString(16).padStart(16, '0'), signature: `S${i}` }));
    const res = await writeBatch(prisma, app.id, payload(items));
    expect(res).toEqual({ signatures: 200, rollups: 200 });
  });

  it('scopes signatures to the app — the same hash in two apps is two rows', async () => {
    const org = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
    const a = await prisma.app.create({ data: { orgId: org.id, name: 'a', env: 'prod' } });
    const b = await prisma.app.create({ data: { orgId: org.id, name: 'b', env: 'prod' } });
    await writeBatch(prisma, a.id, payload([item()]));
    await writeBatch(prisma, b.id, payload([item()]));
    expect(await prisma.querySignature.count()).toBe(2);
  });

  it('is safe under concurrent batches for the same signature and hour', async () => {
    const app = await seedApp();
    await Promise.all(Array.from({ length: 10 }, () => writeBatch(prisma, app.id, payload([item({ count: 1, totalMs: 100, hist: [0, 1, 0, 0, 0, 0, 0, 0] })]))));
    const roll = await prisma.queryRollup.findFirstOrThrow();
    expect(roll.count).toBe(10);
    expect(roll.hist[1]).toBe(10);
  });

  it('handles an empty items list as a no-op', async () => {
    const app = await seedApp();
    expect(await writeBatch(prisma, app.id, payload([]))).toEqual({ signatures: 0, rollups: 0 });
  });

  it('stores bucketHour as the exact UTC instant regardless of session timezone', async () => {
    // Regression test for the timestamptz corruption bug: bucketHour was
    // (and, defense-in-depth, the pool's session timezone still is) subject
    // to a session-timezone-dependent conversion. This test must fail if
    // that conversion is ever wrong again, independent of whatever timezone
    // the connection happens to be in — so it reads the value back two
    // ways: once through the driver, and once with an explicit
    // `AT TIME ZONE 'UTC'` cast in raw SQL, and requires both to agree with
    // the expected instant.
    const app = await seedApp();
    await writeBatch(prisma, app.id, payload([item()], '2026092014'));

    const sig = await prisma.querySignature.findFirstOrThrow({ where: { appId: app.id } });
    const roll = await prisma.queryRollup.findFirstOrThrow({ where: { signatureId: sig.id } });
    const expected = new Date('2026-09-20T14:00:00.000Z');
    expect(roll.bucketHour.getTime()).toBe(expected.getTime());

    const rows = await prisma.$queryRaw<{ bucketHourUtc: Date }[]>`
      SELECT "bucketHour" AT TIME ZONE 'UTC' AS "bucketHourUtc"
      FROM "QueryRollup"
      WHERE id = ${roll.id}
    `;
    expect(rows[0]?.bucketHourUtc.getTime()).toBe(expected.getTime());
  });

  it('rejects a hist array that is not exactly 8 elements at the database level', async () => {
    const app = await seedApp();
    // The contract's zod schema (`hist.length(HIST_SIZE)`) is the normal
    // gate, but this proves the database itself enforces the invariant
    // (via the hist_length_check migration) no matter what path writes the
    // row, so a bypassed or buggy validator still can't corrupt a rollup.
    const bad = item({ hist: [0, 1, 2, 3, 4, 5, 6] as unknown as number[] });
    await expect(writeBatch(prisma, app.id, payload([bad]))).rejects.toThrow(/hist_length_check/);
  });
});
