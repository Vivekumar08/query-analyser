import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { requireRole } from './rbac.js';
import { Prisma } from '../generated/prisma/client.js';
import { effectiveRetentionDays, limitsFor, PlanLimitError, sendPlanLimit } from '../plans.js';
import { lockOrg, lockOwnersAndTarget, lockUser } from './locks.js';

const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
/** OWNER and ADMIN see every app in the org; MEMBER and VIEWER only those with an AppAccess row. */
const orgWide = (role: string) => role === 'OWNER' || role === 'ADMIN';
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
    // Retention is the effective value (the grace included), so the web's
    // range cap matches what the nightly prune keeps.
    const now = new Date();
    return rows.map((r) => ({
      ...r.org,
      role: r.role,
      limits: {
        ...limitsFor(r.org.plan),
        dailyRetentionDays: effectiveRetentionDays(r.org.plan, now, app.config.RETENTION_GRACE_UNTIL),
      },
    }));
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

  // Each member with the apps they can see: OWNER/ADMIN see all of them
  // (`allApps`); MEMBER/VIEWER see their AppAccess rows in this org, in app
  // creation order.
  app.get('/v1/orgs/:org/members', { preHandler: [app.authenticate, app.requireVerified, requireRole('ADMIN')] }, async (req) => {
    const orgId = req.membership.orgId;
    const rows = await app.prisma.membership.findMany({
      where: { orgId },
      select: {
        id: true, role: true, createdAt: true,
        user: {
          select: {
            id: true, email: true, name: true,
            appAccess: {
              where: { app: { orgId } },
              select: { role: true, app: { select: { id: true, name: true } } },
              orderBy: [{ app: { createdAt: 'asc' } }, { appId: 'asc' }],
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ user: { appAccess, ...user }, ...m }) => {
      const allApps = orgWide(m.role);
      return { ...m, user, allApps, apps: allApps ? [] : appAccess.map((a) => ({ id: a.app.id, name: a.app.name, role: a.role })) };
    });
  });

  // Sentinel thrown inside the transaction to signal "the last OWNER would
  // be removed" and mapped to a 409 outside it. Using a thrown value (rather
  // than committing and inspecting a result) lets Prisma roll the
  // transaction back automatically — no risk of leaving it open across a
  // `reply.send`.
  class LastOwnerError extends Error {}
  const NOT_FOUND = Symbol('not-found');

  /**
   * Deletes the user's pending invites in this org. Called whenever their
   * membership changes (role change, removal, leave), so an invite issued
   * before an admin restricted them can't restore what was taken away.
   */
  async function dropPendingInvites(tx: Prisma.TransactionClient, orgId: string, userId: string) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (user) await tx.invite.deleteMany({ where: { orgId, email: user.email.toLowerCase(), acceptedAt: null } });
  }

  /**
   * Locks, then removes the target row, keeping at least one OWNER, along
   * with their AppAccess rows and pending invites in this org, so nothing of
   * theirs survives to revive on a later rejoin.
   *
   * The org lock comes first, before the membership locks, in the same order
   * as accept; the reverse would deadlock against a concurrent accept.
   */
  async function removeMembership(orgId: string, target: { id: string } | { userId: string }) {
    return app.prisma.$transaction(async (tx) => {
      if (!(await lockOrg(tx, orgId))) return NOT_FOUND;
      const { row, ownerCount } = await lockOwnersAndTarget(tx, orgId, target);
      if (!row) return NOT_FOUND;
      if (row.role === 'OWNER' && ownerCount <= 1) throw new LastOwnerError();
      const { count } = await tx.membership.deleteMany({ where: { id: row.id, orgId } });
      if (count === 0) return NOT_FOUND;
      await tx.appAccess.deleteMany({ where: { userId: row.userId, app: { orgId } } });
      await dropPendingInvites(tx, orgId, row.userId);
      return 'ok' as const;
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
        // The org lock first (same order as accept, which would otherwise
        // deadlock against us), so the plan read is the committed one.
        const org = await lockOrg(tx, orgId);
        if (!org) return NOT_FOUND;
        // Scoped by orgId (not just membership id) so a valid membership id
        // belonging to a DIFFERENT org can never be reached through this
        // org's route.
        const { row, ownerCount } = await lockOwnersAndTarget(tx, orgId, { id });
        if (!row) return NOT_FOUND;
        if (row.role === 'OWNER' && role !== 'OWNER' && ownerCount <= 1) throw new LastOwnerError();
        // Setting the current role is a no-op, always allowed, so a member
        // whose role the plan no longer offers (a grandfathered VIEWER on
        // free) isn't refused.
        if (role === row.role) return { id: row.id, role };
        // OWNER is never invitable but can always be granted: being made an
        // owner doesn't count against the target's owned-orgs limit.
        const limits = limitsFor(org.plan);
        if (role !== 'OWNER' && !limits.invitableRoles.includes(role)) throw new PlanLimitError('role', limits.invitableRoles.length);

        const { count } = await tx.membership.updateMany({ where: { id: row.id, orgId }, data: { role } });
        if (count === 0) return NOT_FOUND;

        // Keep AppAccess in step with the new role.
        const inOrg = { userId: row.userId, app: { orgId } };
        if (role === 'MEMBER' || role === 'VIEWER') {
          if (orgWide(row.role)) {
            // Demoted from org-wide: they keep every app they could see.
            const apps = await tx.app.findMany({ where: { orgId }, select: { id: true } });
            await tx.appAccess.createMany({ data: apps.map((a) => ({ appId: a.id, userId: row.userId, role })), skipDuplicates: true });
          } else {
            await tx.appAccess.updateMany({ where: inOrg, data: { role } });
          }
        } else if (!orgWide(row.role)) {
          // Promoted to org-wide: per-app rows mean nothing now.
          await tx.appAccess.deleteMany({ where: inOrg });
        }
        await dropPendingInvites(tx, orgId, row.userId);
        return { id: row.id, role };
      });

      if (updated === NOT_FOUND) return reply.code(404).send({ error: 'Not Found' });
      return updated;
    } catch (err) {
      if (err instanceof PlanLimitError) return sendPlanLimit(reply, err);
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
