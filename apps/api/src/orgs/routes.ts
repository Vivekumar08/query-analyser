import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { requireRole } from './rbac.js';
import { Prisma } from '../generated/prisma/client.js';
import { limitsFor, PlanLimitError, sendPlanLimit } from '../plans.js';
import { lockOwnersAndTarget, lockUser } from './locks.js';

const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
const createSchema = z.object({ name: z.string().min(1).max(100) });
const roleSchema = z.object({ role: z.enum(ROLES) });
// Slugs that collide with static `/dashboard/*` routes in the web app. They
// get the random suffix, exactly as a taken slug does.
const RESERVED_SLUGS = new Set(['account', 'new']);

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'org';
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/orgs', { preHandler: [app.authenticate, app.requireVerified] }, async (req) => {
    const rows = await app.prisma.membership.findMany({
      where: { userId: req.user.id },
      select: { role: true, org: { select: { id: true, name: true, slug: true, plan: true, createdAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ ...r.org, role: r.role, limits: limitsFor(r.org.plan) }));
  });

  app.post('/v1/orgs', { preHandler: [app.authenticate, app.requireVerified] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

    const base = slugify(parsed.data.name);
    const taken = RESERVED_SLUGS.has(base) || (await app.prisma.organization.findUnique({ where: { slug: base } }));
    const slug = taken ? `${base}-${randomBytes(2).toString('hex')}` : base;

    // The org is created only while the caller has created fewer orgs than
    // the largest `ownedOrgs` among the plans of the orgs they created
    // (`free` when they created none). Orgs they were invited into, or
    // promoted to OWNER of, never count and never raise the allowance. The
    // user-row lock serialises one user's concurrent creates, so two can't
    // both pass the count.
    const userId = req.user.id;
    const createOwnedOrg = (orgSlug: string) =>
      app.prisma.$transaction(async (tx) => {
        await lockUser(tx, userId);
        const created = await tx.organization.findMany({ where: { createdById: userId }, select: { plan: true } });
        const max = created.length === 0
          ? limitsFor('free').ownedOrgs
          : Math.max(...created.map((o) => limitsFor(o.plan).ownedOrgs));
        if (created.length >= max) throw new PlanLimitError('orgs', max);
        return tx.organization.create({
          data: { name: parsed.data.name, slug: orgSlug, createdById: userId, memberships: { create: { userId, role: 'OWNER' } } },
          select: { id: true, name: true, slug: true, plan: true, createdAt: true },
        });
      });
    const slugTaken = (err: unknown) =>
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && (err.meta?.target as string[] | undefined)?.includes('slug');

    // The findUnique-then-create above is itself a check-then-act: two
    // concurrent requests choosing the same base slug (or, much more
    // unlikely, colliding on the same random suffix) can both pass the
    // `taken` check and then both attempt to INSERT that slug, so the
    // second `create` fails its unique constraint. Rather than 500 in that
    // case, retry once with a fresh random suffix, in a new transaction that
    // checks the limit again — a second collision right after the first is
    // exceedingly unlikely and not worth looping indefinitely over.
    try {
      const org = await createOwnedOrg(slug).catch((err: unknown) => {
        if (slugTaken(err)) return createOwnedOrg(`${base}-${randomBytes(2).toString('hex')}`);
        throw err;
      });
      return reply.code(201).send({ ...org, role: 'OWNER' });
    } catch (err) {
      if (err instanceof PlanLimitError) return sendPlanLimit(reply, err);
      throw err;
    }
  });

  app.get('/v1/orgs/:org', { preHandler: [app.authenticate, app.requireVerified, requireRole('VIEWER')] }, async (req) => {
    const org = await app.prisma.organization.findUniqueOrThrow({
      where: { id: req.membership.orgId },
      select: { id: true, name: true, slug: true, plan: true, createdAt: true },
    });
    return { ...org, role: req.membership.role };
  });

  app.get('/v1/orgs/:org/members', { preHandler: [app.authenticate, app.requireVerified, requireRole('ADMIN')] }, async (req) => {
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

  /** Locks, then removes the target row, keeping at least one OWNER. */
  async function removeMembership(orgId: string, target: { id: string } | { userId: string }) {
    return app.prisma.$transaction(async (tx) => {
      const { row, ownerCount } = await lockOwnersAndTarget(tx, orgId, target);
      if (!row) return NOT_FOUND;
      if (row.role === 'OWNER' && ownerCount <= 1) throw new LastOwnerError();
      const { count } = await tx.membership.deleteMany({ where: { id: row.id, orgId } });
      return count === 0 ? NOT_FOUND : ('ok' as const);
    });
  }

  app.patch('/v1/orgs/:org/members/:id', { preHandler: [app.authenticate, app.requireVerified, requireRole('OWNER')] }, async (req, reply) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

    const { id } = req.params as { id: string };
    const orgId = req.membership.orgId;
    const role = parsed.data.role;

    try {
      const updated = await app.prisma.$transaction(async (tx) => {
        // Scoped by orgId (not just membership id) so a valid membership id
        // belonging to a DIFFERENT org can never be reached through this
        // org's route.
        const { row, ownerCount } = await lockOwnersAndTarget(tx, orgId, { id });
        if (!row) return NOT_FOUND;
        if (row.role === 'OWNER' && role !== 'OWNER' && ownerCount <= 1) throw new LastOwnerError();

        const { count } = await tx.membership.updateMany({ where: { id: row.id, orgId }, data: { role } });
        return count === 0 ? NOT_FOUND : { id: row.id, role };
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

  app.delete('/v1/orgs/:org/members/:id', { preHandler: [app.authenticate, app.requireVerified, requireRole('OWNER')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await removeMembership(req.membership.orgId, { id });
      if (result === NOT_FOUND) return reply.code(404).send({ error: 'Not Found' });
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof LastOwnerError) {
        return reply.code(409).send({ error: 'organization must keep at least one owner' });
      }
      throw err;
    }
  });

  // The caller leaves the org, under the same lock and last-owner guard as
  // member removal.
  app.delete('/v1/orgs/:org/membership', { preHandler: [app.authenticate, app.requireVerified, requireRole('VIEWER')] }, async (req, reply) => {
    try {
      const result = await removeMembership(req.membership.orgId, { userId: req.user.id });
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
