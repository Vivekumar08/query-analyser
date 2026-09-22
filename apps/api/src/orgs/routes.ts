import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { requireRole } from './rbac.js';
import { Prisma } from '../generated/prisma/client.js';

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

    // The findUnique-then-create above is itself a check-then-act: two
    // concurrent requests choosing the same base slug (or, much more
    // unlikely, colliding on the same random suffix) can both pass the
    // `taken` check and then both attempt to INSERT that slug, so the
    // second `create` fails its unique constraint. Rather than 500 in that
    // case, retry once with a fresh random suffix — a second collision
    // right after the first is exceedingly unlikely and not worth looping
    // indefinitely over.
    try {
      const org = await app.prisma.organization.create({
        data: { name: parsed.data.name, slug, memberships: { create: { userId: req.user.id, role: 'OWNER' } } },
        select: { id: true, name: true, slug: true, plan: true, createdAt: true },
      });
      return reply.code(201).send({ ...org, role: 'OWNER' });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && (err.meta?.target as string[] | undefined)?.includes('slug')) {
        const retrySlug = `${base}-${randomBytes(2).toString('hex')}`;
        const org = await app.prisma.organization.create({
          data: { name: parsed.data.name, slug: retrySlug, memberships: { create: { userId: req.user.id, role: 'OWNER' } } },
          select: { id: true, name: true, slug: true, plan: true, createdAt: true },
        });
        return reply.code(201).send({ ...org, role: 'OWNER' });
      }
      throw err;
    }
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

  // Sentinel thrown inside the transaction to signal "the last OWNER would
  // be removed" and mapped to a 409 outside it. Using a thrown value (rather
  // than committing and inspecting a result) lets Prisma roll the
  // transaction back automatically — no risk of leaving it open across a
  // `reply.send`.
  class LastOwnerError extends Error {}
  const NOT_FOUND = Symbol('not-found');

  app.patch('/v1/orgs/:org/members/:id', { preHandler: [app.authenticate, requireRole('OWNER')] }, async (req, reply) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

    const { id } = req.params as { id: string };
    const orgId = req.membership.orgId;

    try {
      const updated = await app.prisma.$transaction(async (tx) => {
        // Scope the lookup by orgId (not just membership id) so a valid
        // membership id belonging to a DIFFERENT org can never be reached
        // through this org's route.
        const target = await tx.membership.findFirst({ where: { id, orgId } });
        if (!target) return NOT_FOUND;

        if (target.role === 'OWNER' && parsed.data.role !== 'OWNER') {
          // Lock every OWNER row for this org first so a concurrent
          // transaction doing the same check-then-act on a DIFFERENT owner
          // has to wait for this one to commit (or roll back) before it can
          // read the owner count — otherwise two concurrent demotions of
          // two different owners can both observe count === 2, both pass
          // the <= 1 guard, and both commit, leaving zero owners.
          await tx.$queryRaw`SELECT id FROM "Membership" WHERE "orgId" = ${orgId} AND role = 'OWNER'::"Role" FOR UPDATE`;
          const ownerCount = await tx.membership.count({ where: { orgId, role: 'OWNER' } });
          if (ownerCount <= 1) throw new LastOwnerError();
        }

        return tx.membership.update({
          where: { id: target.id },
          data: { role: parsed.data.role },
          select: { id: true, role: true },
        });
      });

      if (updated === NOT_FOUND) return reply.code(404).send({ error: 'Not Found' });
      return updated;
    } catch (err) {
      if (err instanceof LastOwnerError) {
        return reply.code(409).send({ error: 'organization must keep at least one owner' });
      }
      throw err;
    }
  });

  app.delete('/v1/orgs/:org/members/:id', { preHandler: [app.authenticate, requireRole('OWNER')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.membership.orgId;

    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const target = await tx.membership.findFirst({ where: { id, orgId } });
        if (!target) return NOT_FOUND;

        if (target.role === 'OWNER') {
          await tx.$queryRaw`SELECT id FROM "Membership" WHERE "orgId" = ${orgId} AND role = 'OWNER'::"Role" FOR UPDATE`;
          const ownerCount = await tx.membership.count({ where: { orgId, role: 'OWNER' } });
          if (ownerCount <= 1) throw new LastOwnerError();
        }

        await tx.membership.delete({ where: { id: target.id } });
        return 'ok' as const;
      });

      if (result === NOT_FOUND) return reply.code(404).send({ error: 'Not Found' });
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof LastOwnerError) {
        return reply.code(409).send({ error: 'organization must keep at least one owner' });
      }
      throw err;
    }
  });
}
