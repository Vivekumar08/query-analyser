import type { FastifyReply, FastifyRequest } from 'fastify';
import { Role } from '../db.js';

const RANK: Record<Role, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1, VIEWER: 0 };

export function roleAtLeast(actual: Role, min: Role): boolean {
  return RANK[actual] >= RANK[min];
}

/**
 * preHandler factory: resolve the caller's membership in `:org` (an org id,
 * never a slug) and enforce a minimum role.
 *
 * Non-members get 404, not 403 — org ids must not be enumerable by probing
 * for a 403-vs-404 difference. A suspended org also 403s every member,
 * including an OWNER, once membership is confirmed to exist.
 */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const orgId = (req.params as { org?: string }).org;
    if (!orgId) {
      await reply.code(404).send({ error: 'Not Found' });
      return;
    }
    const membership = await req.server.prisma.membership.findUnique({
      where: { userId_orgId: { userId: req.user.id, orgId } },
      select: { orgId: true, role: true, org: { select: { suspendedAt: true } } },
    });
    if (!membership) {
      await reply.code(404).send({ error: 'Not Found' });
      return;
    }
    if (membership.org.suspendedAt) {
      await reply.code(403).send({ error: 'organization suspended' });
      return;
    }
    if (!roleAtLeast(membership.role, min)) {
      await reply.code(403).send({ error: 'insufficient role' });
      return;
    }
    req.membership = { orgId: membership.orgId, role: membership.role };
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    membership: { orgId: string; role: Role };
  }
}
