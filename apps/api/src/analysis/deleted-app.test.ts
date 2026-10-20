import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { PrismaClient } from '../db.js';
import { runHourlyJobs, runNightlyJobs, detectNewExpensive } from './jobs.js';

// An app deleted while a job runs (A7-2): the job read its signatures, then
// the delete cascaded them away, then the job writes an alert or advice for
// one of them. That write fails on its foreign key. It must skip that row,
// not abort the run for every other org.

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

/**
 * `prisma` with `model.method` wrapped so `before(args)` runs once, just
 * before the first call: the seam that lets a test delete an app between the
 * job's read and its write.
 */
function interleave(prisma: PrismaClient, model: 'alert' | 'advice', method: 'create' | 'upsert', before: (args: any) => Promise<void>): PrismaClient {
  let fired = false;
  const bind = (t: object, v: unknown) => (typeof v === 'function' ? v.bind(t) : v);
  return new Proxy(prisma, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop !== model) return bind(target, v);
      const delegate = v as object;
      return new Proxy(delegate, {
        get(t, p) {
          const f = Reflect.get(t, p) as (args: unknown) => Promise<unknown>;
          if (p !== method) return bind(t, f);
          return async (args: unknown) => {
            if (!fired) { fired = true; await before(args); }
            return f.call(t, args);
          };
        },
      });
    },
  });
}

/** Deletes the app owning `signatureId`, as an admin would mid-run. */
async function deleteAppOf(signatureId: string) {
  const sig = await app.prisma.querySignature.findUniqueOrThrow({ where: { id: signatureId }, select: { appId: true } });
  await app.prisma.app.delete({ where: { id: sig.appId } });
}

let n = 0;
async function signatureInNewOrg(opts: { filterShape?: object[]; firstSeen?: Date } = {}) {
  n += 1;
  const org = await app.prisma.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}-${Date.now()}` } });
  const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'production' } });
  const sig = await app.prisma.querySignature.create({
    data: {
      appId: a.id, hash: n.toString(16).padStart(16, '0'), signature: `users.find(${n})`, model: 'users', operation: 'find',
      filterShape: opts.filterShape ?? [], sortKeys: [], stages: [],
      ...(opts.firstSeen ? { firstSeen: opts.firstSeen, lastSeen: opts.firstSeen } : {}),
    },
  });
  return sig.id;
}

describe('jobs skip a row whose app was deleted mid-run', () => {
  it('runHourlyJobs writes the other orgs\' regression alerts', async () => {
    const NOW = new Date('2026-09-20T03:30:00.000Z');
    const LAST = new Date('2026-09-20T02:00:00.000Z');
    const trailing = ['2026-09-19T02:00:00.000Z', '2026-09-18T02:00:00.000Z', '2026-09-17T02:00:00.000Z'].map((d) => new Date(d));
    const sigs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await signatureInNewOrg();
      await app.prisma.queryRollup.createMany({
        data: [
          ...trailing.map((bucketHour) => ({ signatureId: id, bucketHour, count: 20, totalMs: 1800n, maxMs: 99, hist: [20, 0, 0, 0, 0, 0, 0, 0] })),
          { signatureId: id, bucketHour: LAST, count: 25, totalMs: 25n * 975n, maxMs: 999, hist: [0, 0, 0, 25, 0, 0, 0, 0] },
        ],
      });
      sigs.push(id);
    }
    let victim = '';
    const prisma = interleave(app.prisma, 'alert', 'create', async (args) => {
      victim = args.data.signatureId;
      await deleteAppOf(victim);
    });
    const r = await runHourlyJobs({ prisma, now: NOW });
    expect(r.alertsCreated).toBe(2);
    const alerted = (await app.prisma.alert.findMany({ select: { signatureId: true } })).map((a) => a.signatureId).sort();
    expect(alerted).toEqual(sigs.filter((s) => s !== victim).sort());
  });

  it('detectNewExpensive writes the other apps\' alerts', async () => {
    const now = new Date('2026-09-20T02:00:00.000Z');
    const recent = new Date('2026-09-19T20:00:00.000Z');
    const sigs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await signatureInNewOrg({ firstSeen: recent });
      await app.prisma.queryRollup.create({
        data: { signatureId: id, bucketHour: recent, count: 100, totalMs: 999_000n, maxMs: 500, hist: [0, 0, 0, 100, 0, 0, 0, 0] },
      });
      sigs.push(id);
    }
    let victim = '';
    const prisma = interleave(app.prisma, 'alert', 'create', async (args) => {
      victim = args.data.signatureId;
      await deleteAppOf(victim);
    });
    expect(await detectNewExpensive({ prisma, now })).toBe(2);
    const alerted = (await app.prisma.alert.findMany({ select: { signatureId: true } })).map((a) => a.signatureId).sort();
    expect(alerted).toEqual(sigs.filter((s) => s !== victim).sort());
  });

  it('the nightly advice refresh writes the other apps\' advice', async () => {
    const sigs: string[] = [];
    for (let i = 0; i < 3; i++) sigs.push(await signatureInNewOrg({ filterShape: [{ key: 'email', op: 'eq' }] }));
    let victim = '';
    const prisma = interleave(app.prisma, 'advice', 'upsert', async (args) => {
      victim = args.where.signatureId;
      await deleteAppOf(victim);
    });
    const r = await runNightlyJobs({ prisma, now: new Date('2026-09-20T02:00:00.000Z') });
    expect(r.adviceWritten).toBe(2);
    const advised = (await app.prisma.advice.findMany({ select: { signatureId: true } })).map((a) => a.signatureId).sort();
    expect(advised).toEqual(sigs.filter((s) => s !== victim).sort());
  });
});
