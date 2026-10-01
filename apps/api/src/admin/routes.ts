import type { FastifyInstance } from 'fastify';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requirePlatformAdmin] };

  app.get('/v1/admin/orgs', guard, async () => {
    const rows = await app.prisma.organization.findMany({
      select: { id: true, name: true, slug: true, plan: true, suspendedAt: true, createdAt: true, _count: { select: { apps: true, memberships: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(({ _count, ...o }) => ({ ...o, appCount: _count.apps, memberCount: _count.memberships }));
  });

  app.get('/v1/admin/orgs/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const org = await app.prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true, plan: true, suspendedAt: true, createdAt: true,
        apps: { select: { id: true, name: true, env: true, _count: { select: { signatures: true } } } } },
    });
    if (!org) return reply.code(404).send({ error: 'Not Found' });
    return { ...org, apps: org.apps.map(({ _count, ...a }) => ({ ...a, signatureCount: _count.signatures })) };
  });

  for (const [path, value] of [['suspend', () => new Date()], ['unsuspend', () => null]] as const) {
    app.post(`/v1/admin/orgs/:id/${path}`, guard, async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = await app.prisma.organization.updateMany({ where: { id }, data: { suspendedAt: value() } });
      if (r.count === 0) return reply.code(404).send({ error: 'Not Found' });
      return reply.code(204).send();
    });
  }

  app.get('/v1/admin/health', guard, async () => app.ingestStats);
}
