import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { detectNewExpensive } from './jobs.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let appId: string;

interface SigOpts {
  /** Which app the signature belongs to. Defaults to the shared `appId`. */
  appId?: string;
  /** Where the rollup carrying `totalMs` sits. Defaults to `firstSeen`. */
  bucketHour?: Date;
  /**
   * An extra rollup outside the 24-hour ranking window. This is what an
   * established signature actually looks like: hourly retention is 7 days,
   * so it has up to a week of accumulated `totalMs` behind it.
   */
  accumulated?: { bucketHour: Date; totalMs: bigint };
}

async function signature(hash: string, firstSeen: Date, totalMs: bigint, opts: SigOpts = {}) {
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: opts.appId ?? appId,
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
      bucketHour: opts.bucketHour ?? firstSeen,
      count: 100,
      totalMs,
      maxMs: 500,
      hist: [0, 0, 0, 100, 0, 0, 0, 0],
    },
  });
  if (opts.accumulated) {
    await app.prisma.queryRollup.create({
      data: {
        signatureId: sig.id,
        bucketHour: opts.accumulated.bucketHour,
        count: 100,
        totalMs: opts.accumulated.totalMs,
        maxMs: 500,
        hist: [0, 0, 0, 100, 0, 0, 0, 0],
      },
    });
  }
  return sig.id;
}

/** A second tenant, so "top ten for its app" can be told apart from "top ten". */
async function otherApp(): Promise<string> {
  const org = await app.prisma.organization.create({
    data: { name: 'NE2', slug: `ne2-${Date.now()}-${Math.random()}` },
  });
  const a = await app.prisma.app.create({
    data: { orgId: org.id, name: 'ne2', env: 'production' },
  });
  return a.id;
}

const hasAlert = async (signatureId: string) =>
  (await app.prisma.alert.count({ where: { signatureId, kind: 'new_expensive' } })) > 0;

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

  /**
   * Pins `rank <= TOP_N`. "Top ten for its app" is half the rule, and with
   * two signatures per test rank is always <= 10, so deleting the clause
   * changes nothing an under-seeded fixture can observe. Eleven signatures
   * is the smallest fixture that can tell the clause is there.
   */
  it('alerts the top ten and not the eleventh, however new', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      // Descending totalMs, so ids[10] is unambiguously rank 11.
      ids.push(
        await signature(`00000000000001${String(i).padStart(2, '0')}`, recent, BigInt(11 - i) * 1000n),
      );
    }

    expect(await detectNewExpensive({ prisma: app.prisma, now })).toBe(10);

    for (const id of ids.slice(0, 10)) expect(await hasAlert(id)).toBe(true);
    expect(await hasAlert(ids[10]!)).toBe(false);
  });

  /**
   * Pins `PARTITION BY s."appId"`. Every other test seeds one app, so the
   * partition is unobservable: drop it and ranking silently becomes global,
   * which means one large tenant crowds out every smaller tenant's alerts.
   */
  it('ranks within the app, so a heavy tenant does not suppress a quiet one', async () => {
    // The quiet tenant's only signature is modest in absolute terms...
    const quiet = await signature('0000000000000201', recent, 100n);

    // ...while the loud tenant fills a global top ten on its own.
    const loudAppId = await otherApp();
    for (let i = 0; i < 10; i += 1) {
      await signature(`00000000000003${String(i).padStart(2, '0')}`, recent, 1_000_000n, {
        appId: loudAppId,
      });
    }

    const created = await detectNewExpensive({ prisma: app.prisma, now });

    // Rank 1 of its own app, even though it is rank 11 globally.
    expect(await hasAlert(quiet)).toBe(true);
    expect(created).toBe(11);
  });

  /**
   * Pins the ranking WINDOW. Without a `bucketHour` predicate on the join,
   * established signatures are ranked on up to 7 days of accumulated totalMs
   * while the candidate has at most 24 hours, so a genuinely new expensive
   * query has to be ~7x worse than an established one to reach the top ten.
   * Here each established signature is a thousand times heavier than the
   * candidate over its lifetime and a thousand times lighter over the last
   * 24 hours -- which is precisely the case the rule exists to catch, and
   * the case the asymmetric window silently drops.
   */
  it('ranks everyone over the same trailing 24 hours', async () => {
    for (let i = 0; i < 10; i += 1) {
      await signature(`00000000000004${String(i).padStart(2, '0')}`, old, 1n, {
        bucketHour: recent,
        accumulated: { bucketHour: old, totalMs: 1_000_000n },
      });
    }

    const fresh = await signature('0000000000000499', recent, 1000n);

    expect(await detectNewExpensive({ prisma: app.prisma, now })).toBe(1);
    expect(await hasAlert(fresh)).toBe(true);
  });
});
