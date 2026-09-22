import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { requireRole } from './rbac.js';

const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
const createSchema = z.object({ name: z.string().min(1).max(100) });
const roleSchema = z.object({ role: z.enum(ROLES) });

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'org';
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/orgs', { preHandler: [app.authenticate] }, async (req) => {
    const rows = await app.prisma.membership.findMany({
      where: { userId: req.user.id },
      select: { role: true, org: { select: { id: true, name: true, slug: true, plan: true, createdAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ ...r.org, role: r.role }));
  });

  app.post('/v1/orgs', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

    const base = slugify(parsed.data.name);
    const taken = await app.prisma.organization.findUnique({ where: { slug: base } });
    const slug = taken ? `${base}-${randomBytes(2).toString('hex')}` : base;

    const org = await app.prisma.organization.create({
      data: { name: parsed.data.name, slug, memberships: { create: { userId: req.user.id, role: 'OWNER' } } },
      select: { id: true, name: true, slug: true, plan: true, createdAt: true },
    });
    return reply.code(201).send({ ...org, role: 'OWNER' });
  });

  app.get('/v1/orgs/:org', { preHandler: [app.authenticate, requireRole('VIEWER')] }, async (req) => {
    const org = await app.prisma.organization.findUniqueOrThrow({
      where: { id: req.membership.orgId },
      select: { id: true, name: true, slug: true, plan: true, createdAt: true },
    });
    return { ...org, role: req.membership.role };
  });

  app.get('/v1/orgs/:org/members', { preHandler: [app.authenticate, requireRole('ADMIN')] }, async (req) => {
    return app.prisma.membership.findMany({
      where: { orgId: req.membership.orgId },
      select: { id: true, role: true, createdAt: true, user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  const ownerCount = (orgId: string) => app.prisma.membership.count({ where: { orgId, role: 'OWNER' } });

  app.patch('/v1/orgs/:org/members/:id', { preHandler: [app.authenticate, requireRole('OWNER')] }, async (req, reply) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

    const { id } = req.params as { id: string };
    // Scope the lookup by orgId (not just membership id) so a valid
    // membership id belonging to a DIFFERENT org can never be reached
    // through this org's route.
    const target = await app.prisma.membership.findFirst({ where: { id, orgId: req.membership.orgId } });
    if (!target) return reply.code(404).send({ error: 'Not Found' });

    if (target.role === 'OWNER' && parsed.data.role !== 'OWNER' && (await ownerCount(target.orgId)) <= 1) {
      return reply.code(409).send({ error: 'organization must keep at least one owner' });
    }

    const updated = await app.prisma.membership.update({
      where: { id: target.id },
      data: { role: parsed.data.role },
      select: { id: true, role: true },
    });
    return updated;
  });

  app.delete('/v1/orgs/:org/members/:id', { preHandler: [app.authenticate, requireRole('OWNER')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await app.prisma.membership.findFirst({ where: { id, orgId: req.membership.orgId } });
    if (!target) return reply.code(404).send({ error: 'Not Found' });

    if (target.role === 'OWNER' && (await ownerCount(target.orgId)) <= 1) {
      return reply.code(409).send({ error: 'organization must keep at least one owner' });
    }

    await app.prisma.membership.delete({ where: { id: target.id } });
    return reply.code(204).send();
  });
}
