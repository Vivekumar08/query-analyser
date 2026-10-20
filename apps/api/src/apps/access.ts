import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAppRole } from '../orgs/rbac.js';
import { lockOrg } from '../orgs/locks.js';
import { seatState } from '../orgs/seats.js';
import { limitsFor } from '../plans.js';

/** User ids are UUIDs; anything else can't name a row, so it's a plain 404. */
const userIdSchema = z.string().uuid();

/** Who can open an app, and per-app revocation. Both are ADMIN+. */
export async function accessRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [app.authenticate, app.requireVerified, requireAppRole('ADMIN')] };

  // Org OWNER/ADMINs see every app ("all apps"); everyone else is listed by
  // their AppAccess row for this app, with the row's role. Invites are this
  // app's pending ones only. Seats are org-wide.
  app.get('/v1/apps/:id/access', auth, async (req) => {
    const { orgId } = req.membership;
    const appId = req.appId;
    const now = new Date();
    const userSelect = { select: { id: true, name: true, email: true } } as const;
    const [org, admins, rows, invites, seats] = await Promise.all([
      app.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { plan: true } }),
      app.prisma.membership.findMany({
        where: { orgId, role: { in: ['OWNER', 'ADMIN'] } },
        select: { role: true, user: userSelect },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      // Only current members: the database doesn't tie a row to a
      // membership, and an orphan row must not list a non-member here.
      app.prisma.appAccess.findMany({
        where: { appId, user: { memberships: { some: { orgId } } } },
        select: { role: true, user: userSelect },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      app.prisma.invite.findMany({
        where: { appId, acceptedAt: null, expiresAt: { gt: now } },
        select: { id: true, email: true, role: true, expiresAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      seatState(app.prisma, orgId, now),
    ]);
    const person = (allApps: boolean) => ({ role, user }: (typeof rows)[number]) =>
      ({ userId: user.id, name: user.name, email: user.email, role, allApps });
    return {
      people: [...admins.map(person(true)), ...rows.map(person(false))],
      invites,
      seats: { used: seats.used, max: limitsFor(org.plan).seats },
    };
  });

  // Removes one app's access. The membership stays (so does its seat), and
  // so do their other apps. Their pending invites to this app go too
  // (Ruling A5-1), so one can't restore what was just taken away. Under the
  // org lock, so it serialises with an accept granting the same row: without
  // it, a revoke could miss a row an accept is committing and report 404
  // while the access survives.
  app.delete('/v1/apps/:id/access/:userId', auth, async (req, reply) => {
    const parsed = userIdSchema.safeParse((req.params as { userId?: unknown }).userId);
    if (!parsed.success) return reply.code(404).send({ error: 'Not Found' });
    const userId = parsed.data;
    const appId = req.appId;
    const removed = await app.prisma.$transaction(async (tx) => {
      if (!(await lockOrg(tx, req.membership.orgId))) return false;
      const { count } = await tx.appAccess.deleteMany({ where: { appId, userId } });
      if (count === 0) return false;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (user) await tx.invite.deleteMany({ where: { appId, email: user.email.toLowerCase(), acceptedAt: null } });
      return true;
    });
    if (!removed) return reply.code(404).send({ error: 'Not Found' });
    return reply.code(204).send();
  });
}
