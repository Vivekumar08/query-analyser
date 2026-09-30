import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, requireAppRole } from '../orgs/rbac.js';
import { generateKey } from '../ingest/keys.js';

const createSchema = z.object({ name: z.string().min(1).max(100), env: z.string().min(1).max(40) });
const appSelect = { id: true, name: true, env: true, createdAt: true } as const;

export async function appRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/orgs/:org/apps', { preHandler: [app.authenticate, requireRole('VIEWER')] }, async (req) =>
    app.prisma.app.findMany({ where: { orgId: req.membership.orgId }, select: appSelect, orderBy: { createdAt: 'asc' } }));

  app.post('/v1/orgs/:org/apps', { preHandler: [app.authenticate, requireRole('MEMBER')] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const exists = await app.prisma.app.findUnique({ where: { orgId_name_env: { orgId: req.membership.orgId, ...parsed.data } } });
    if (exists) return reply.code(409).send({ error: 'app already exists for this env' });
    const created = await app.prisma.app.create({ data: { orgId: req.membership.orgId, ...parsed.data }, select: appSelect });
    return reply.code(201).send(created);
  });

  app.get('/v1/apps/:id', { preHandler: [app.authenticate, requireAppRole('VIEWER')] }, async (req) => {
    const a = await app.prisma.app.findUniqueOrThrow({ where: { id: req.appId }, select: { ...appSelect, orgId: true } });
    const [keyCount, last] = await Promise.all([
      app.prisma.ingestKey.count({ where: { appId: req.appId, revokedAt: null } }),
      app.prisma.ingestKey.aggregate({ where: { appId: req.appId }, _max: { lastUsedAt: true } }),
    ]);
    return { ...a, ingest: { lastSeenAt: last._max.lastUsedAt, keyCount } };
  });

  app.get('/v1/apps/:id/keys', { preHandler: [app.authenticate, requireAppRole('ADMIN')] }, async (req) =>
    app.prisma.ingestKey.findMany({
      where: { appId: req.appId }, select: { id: true, prefix: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }));

  app.post('/v1/apps/:id/keys', { preHandler: [app.authenticate, requireAppRole('ADMIN')] }, async (req, reply) => {
    const k = generateKey();
    const row = await app.prisma.ingestKey.create({ data: { appId: req.appId, keyHash: k.hash, prefix: k.prefix }, select: { id: true, prefix: true, createdAt: true } });
    return reply.code(201).send({ ...row, key: k.key });
  });

  app.delete('/v1/apps/:id/keys/:keyId', { preHandler: [app.authenticate, requireAppRole('ADMIN')] }, async (req, reply) => {
    const { keyId } = req.params as { keyId: string };
    const row = await app.prisma.ingestKey.findFirst({ where: { id: keyId, appId: req.appId } });
    if (!row) return reply.code(404).send({ error: 'Not Found' });
    await app.prisma.ingestKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
    app.keys.invalidate(row.keyHash);
    return reply.code(204).send();
  });
}
