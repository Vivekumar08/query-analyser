import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { detectNewExpensive } from './jobs.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let appId: string;

async function signature(hash: string, firstSeen: Date, totalMs: bigint) {
  const sig = await app.prisma.querySignature.create({
    data: {
      appId,
      hash,
      signature: `orders.find({${hash}})`,
      model: 'orders',
      operation: 'find',
      filterShape: [],
      sortKeys: [],
      stages: [],
      firstSeen,
      lastSeen: firstSeen,
    },
  });
  await app.prisma.queryRollup.create({
    data: {
      signatureId: sig.id,
      bucketHour: firstSeen,
      count: 100,
      totalMs,
      maxMs: 500,
      hist: [0, 0, 0, 100, 0, 0, 0, 0],
    },
  });
  return sig.id;
}

beforeEach(async () => {
  app = await buildApp();
  await resetDb(app.prisma);
  const org = await app.prisma.organization.create({
    data: { name: 'NE', slug: `ne-${Date.now()}` },
  });
  const a = await app.prisma.app.create({
    data: { orgId: org.id, name: 'ne', env: 'production' },
  });
  appId = a.id;
});

afterAll(async () => {
  await app?.close();
});

describe('detectNewExpensive', () => {
  const now = new Date('2026-09-20T02:00:00.000Z');
  const recent = new Date('2026-09-19T20:00:00.000Z');
  const old = new Date('2026-09-01T20:00:00.000Z');

  it('alerts a signature first seen within 24 hours that is among the heaviest', async () => {
    await signature('0000000000000001', old, 100n);
    const newId = await signature('0000000000000002', recent, 999_000n);

    const created = await detectNewExpensive({ prisma: app.prisma, now });
    expect(created).toBe(1);

    const alert = await app.prisma.alert.findFirstOrThrow({ where: { signatureId: newId } });
    expect(alert.kind).toBe('new_expensive');
  });

  it('ignores a signature older than 24 hours however heavy', async () => {
    await signature('0000000000000003', old, 999_000n);
    expect(await detectNewExpensive({ prisma: app.prisma, now })).toBe(0);
  });

  it('does not alert the same signature twice', async () => {
    await signature('0000000000000004', recent, 999_000n);
    await detectNewExpensive({ prisma: app.prisma, now });
    const second = await detectNewExpensive({ prisma: app.prisma, now });
    expect(second).toBe(0);
  });
});
