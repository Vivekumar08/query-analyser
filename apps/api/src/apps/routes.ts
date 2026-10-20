import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, requireAppRole } from '../orgs/rbac.js';
import { generateKey } from '../ingest/keys.js';
import { Prisma } from '../generated/prisma/client.js';
import { sampleKeyRoutes } from './sample-key.js';
import { lockOrg } from '../orgs/locks.js';
import { limitsFor, PlanLimitError, sendPlanLimit } from '../plans.js';

const createSchema = z.object({ name: z.string().min(1).max(100), env: z.string().min(1).max(40) });
const appSelect = { id: true, name: true, env: true, createdAt: true } as const;

export async function appRoutes(app: FastifyInstance): Promise<void> {
  await app.register(sampleKeyRoutes);

  app.get('/v1/orgs/:org/apps', { preHandler: [app.authenticate, app.requireVerified, requireRole('VIEWER')] }, async (req) =>
    app.prisma.app.findMany({ where: { orgId: req.membership.orgId }, select: appSelect, orderBy: { createdAt: 'asc' } }));

  app.post('/v1/orgs/:org/apps', { preHandler: [app.authenticate, app.requireVerified, requireRole('ADMIN')] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const orgId = req.membership.orgId;
    const DUPLICATE = Symbol('duplicate');
    const GONE = Symbol('gone');
    // One transaction under the org-row lock, so concurrent creates of
    // different apps can't both pass the count. The duplicate check comes
    // first: a repeated (name, env) is a 409 whatever the plan.
    //
    // The duplicate check is still a check-then-act for the same
    // (orgId, name, env) on its own, so keep the P2002 catch: Prisma's P2002
    // carries no `statusCode`, and without it a lost race would fall through
    // to the generic error handler as a 500 instead of the spec'd 409.
    try {
      const created = await app.prisma.$transaction(async (tx) => {
        const org = await lockOrg(tx, orgId);
        if (!org) return GONE; // deleted after requireRole passed
        const exists = await tx.app.findUnique({ where: { orgId_name_env: { orgId, ...parsed.data } } });
        if (exists) return DUPLICATE;
        const max = limitsFor(org.plan).apps;
        if ((await tx.app.count({ where: { orgId } })) >= max) throw new PlanLimitError('apps', max);
        return tx.app.create({ data: { orgId, ...parsed.data }, select: appSelect });
      });
      if (created === GONE) return reply.code(404).send({ error: 'Not Found' });
      if (created === DUPLICATE) return reply.code(409).send({ error: 'app already exists for this env' });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof PlanLimitError) return sendPlanLimit(reply, err);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({ error: 'app already exists for this env' });
      }
      throw err;
    }
  });

  app.get('/v1/apps/:id', { preHandler: [app.authenticate, app.requireVerified, requireAppRole('VIEWER')] }, async (req) => {
    const a = await app.prisma.app.findUniqueOrThrow({ where: { id: req.appId }, select: { ...appSelect, orgId: true } });
    const [keyCount, last] = await Promise.all([
      app.prisma.ingestKey.count({ where: { appId: req.appId, revokedAt: null } }),
      app.prisma.ingestKey.aggregate({ where: { appId: req.appId }, _max: { lastUsedAt: true } }),
    ]);
    return { ...a, ingest: { lastSeenAt: last._max.lastUsedAt, keyCount } };
  });

  app.get('/v1/apps/:id/keys', { preHandler: [app.authenticate, app.requireVerified, requireAppRole('ADMIN')] }, async (req) =>
    app.prisma.ingestKey.findMany({
      where: { appId: req.appId }, select: { id: true, prefix: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }));

  app.post('/v1/apps/:id/keys', { preHandler: [app.authenticate, app.requireVerified, requireAppRole('ADMIN')] }, async (req, reply) => {
    const k = generateKey();
    const row = await app.prisma.ingestKey.create({ data: { appId: req.appId, keyHash: k.hash, prefix: k.prefix }, select: { id: true, prefix: true, createdAt: true } });
    return reply.code(201).send({ ...row, key: k.key });
  });

  app.delete('/v1/apps/:id/keys/:keyId', { preHandler: [app.authenticate, app.requireVerified, requireAppRole('ADMIN')] }, async (req, reply) => {
    const { keyId } = req.params as { keyId: string };
    const row = await app.prisma.ingestKey.findFirst({ where: { id: keyId, appId: req.appId, revokedAt: null } });
    if (!row) return reply.code(404).send({ error: 'Not Found' });
    await app.prisma.ingestKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
    app.keys.invalidate(row.keyHash);
    return reply.code(204).send();
  });
}
