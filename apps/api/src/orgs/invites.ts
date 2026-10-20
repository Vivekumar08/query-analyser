import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { requireRole } from './rbac.js';
import { Prisma } from '../generated/prisma/client.js';
import { inviteEmail } from '../mail/templates.js';
import { lockOrg, lockOwnersAndTarget } from './locks.js';
import { seatState } from './seats.js';
import { limitsFor, PlanLimitError, sendPlanLimit } from '../plans.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
// Every invite sends mail from the product's sender, so creation is
// throttled like the other mail-sending routes (auth/routes.ts). How many
// people an org can have pending is bounded by its plan's seats, checked
// under the org lock below.
const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
const createSchema = z.object({
  email: z.string().email().max(200),
  role: z.enum(ROLES),
  appId: z.string().min(1).max(64).nullish(),
});
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// Sentinel thrown inside the acceptance transaction when the invite was
// consumed (or expired) between the pre-transaction read and the atomic
// claim below, and mapped to a 410 outside it — mirroring the LastOwnerError
// pattern in orgs/routes.ts.
class InviteGoneError extends Error {}

// Returned (never thrown) from the acceptance transaction when the invite
// grants nothing the user doesn't already have. Returning lets the claim
// commit, so the invite is consumed: it leaves the pending list and frees its
// seat instead of lingering forever. Mapped to a 409 outside.
const ALREADY = Symbol('already-a-member');

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/orgs/:org/invites', {
    preHandler: [app.authenticate, app.requireVerified, requireRole('ADMIN')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    // MEMBER/VIEWER are invited to one app; OWNER/ADMIN are org-wide. The
    // database doesn't enforce this, so the API does, before any DB work.
    const { role } = parsed.data;
    const appId = parsed.data.appId ?? null;
    const appScoped = role === 'MEMBER' || role === 'VIEWER';
    if (appScoped !== (appId !== null)) return reply.code(400).send({ error: 'invalid body' });
    const email = parsed.data.email.toLowerCase();
    const orgId = req.membership.orgId;
    const token = randomBytes(32).toString('base64url');

    // One transaction under the org-row lock, so the plan read here is the
    // committed one and two concurrent invites of new emails can't both take
    // the last seat. OWNER is in no plan's invitable roles, so the
    // privilege-escalation gate (an ADMIN minting an OWNER invite) holds on
    // every plan.
    const NOT_FOUND = Symbol('not-found');
    let row;
    try {
      row = await app.prisma.$transaction(async (tx) => {
        const org = await lockOrg(tx, orgId);
        if (!org) return NOT_FOUND; // deleted after requireRole passed
        const limits = limitsFor(org.plan);
        if (!limits.invitableRoles.includes(role)) throw new PlanLimitError('role', limits.invitableRoles.length);
        // Another org's app 404s exactly like a nonexistent one.
        if (appId !== null && !(await tx.app.findFirst({ where: { id: appId, orgId }, select: { id: true } }))) return NOT_FOUND;
        // A seat is a distinct person: re-inviting a pending email, or
        // inviting an existing member to another app, adds nobody.
        const seats = await seatState(tx, orgId);
        if (!seats.emails.has(email) && seats.used >= limits.seats) throw new PlanLimitError('seats', limits.seats);
        return tx.invite.create({
          data: { orgId, appId, email, role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
          select: {
            id: true, email: true, role: true, appId: true, expiresAt: true,
            org: { select: { name: true } },
            app: { select: { name: true } },
          },
        });
      });
    } catch (err) {
      if (err instanceof PlanLimitError) return sendPlanLimit(reply, err);
      throw err;
    }
    if (row === NOT_FOUND) return reply.code(404).send({ error: 'Not Found' });
    const { org, app: invitedTo, ...invite } = row;

    // A mail failure must never fail the invite: the admin still gets the
    // token below and can copy the link by hand. `mailer.send` swallows SMTP
    // errors itself, but guard anyway, and log only the error's name — the
    // message could quote the link, and the link carries the token.
    const link = new URL('/invite', app.config.WEB_ORIGIN);
    link.searchParams.set('token', token);
    const href = link.toString();
    try {
      // The org, app and inviter names are user-controlled; the template
      // escapes them for the html and flattens them for the subject header.
      const inviter = await app.prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true, email: true } });
      await app.mailer.send({
        to: invite.email,
        ...inviteEmail({
          href,
          orgName: org.name,
          inviterName: inviter?.name?.trim() || inviter?.email || 'A teammate',
          role: invite.role,
          ttlMs: INVITE_TTL_MS,
          appName: invitedTo?.name,
        }),
      });
    } catch (err) {
      req.log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'invite mail failed');
    }

    // The token is a bearer credential for org membership — return it
    // exactly once, here, and never again (the list route below never
    // selects tokenHash). The accept route below carries this same token in
    // its URL, which Fastify's default request-log serializer would
    // otherwise log verbatim on every hit (including failed attempts); that
    // is redacted centrally in `buildApp` (see `reqSerializer` in app.ts),
    // not here.
    return reply.code(201).send({ ...invite, token });
  });

  app.get('/v1/orgs/:org/invites', { preHandler: [app.authenticate, app.requireVerified, requireRole('ADMIN')] }, async (req) =>
    app.prisma.invite.findMany({
      where: { orgId: req.membership.orgId, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, appId: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }));

  // Revoking deletes the row, so the accept route sees a revoked token as
  // unknown (404). Only a still-pending invite in *this* org can be revoked;
  // another org's, an accepted or an expired one all 404 alike, so ids from
  // elsewhere can't be probed.
  app.delete('/v1/orgs/:org/invites/:id', { preHandler: [app.authenticate, app.requireVerified, requireRole('ADMIN')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { count } = await app.prisma.invite.deleteMany({
      where: { id, orgId: req.membership.orgId, acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    if (count === 0) return reply.code(404).send({ error: 'Not Found' });
    return reply.code(204).send();
  });

  // A URL token must never reach a mutation without being resolved and
  // gated first: we look the invite up by its hash before doing anything
  // else, and 404 unknown, 410 expired/used and 403 suspended or wrong email
  // are all checked before any write. Whether the user already has what the
  // invite grants (409) is decided inside the transaction, under the locks.
  //
  // What an accepted invite grants:
  // - OWNER/ADMIN (org-wide): a membership with that role. An ADMIN invite to
  //   an existing MEMBER/VIEWER promotes them to ADMIN and drops their
  //   AppAccess rows in this org (ADMIN sees every app). Anyone else already
  //   in the org gets 409 (a legacy OWNER invite never promotes).
  // - MEMBER/VIEWER: AppAccess with the invite's role to its app or, for a
  //   legacy invite issued before invites carried an app (appId null), to
  //   every app in the org. A newcomer also gets a membership with that role;
  //   an existing member keeps theirs (the app role may exceed it). An OWNER
  //   or ADMIN already sees every app: 409. So does a member who already has
  //   every row with that role.
  app.post('/v1/invites/:token/accept', { preHandler: [app.authenticate, app.requireVerified] }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const inv = await app.prisma.invite.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { org: { select: { suspendedAt: true, slug: true } } },
    });
    if (!inv) return reply.code(404).send({ error: 'Not Found' });
    if (inv.acceptedAt || inv.expiresAt < new Date()) {
      return reply.code(410).send({ error: 'invite no longer valid' });
    }
    // A suspended org must not gain members through acceptance any more
    // than it can issue invites — `requireRole` already 403s issuance/list
    // for a suspended org, but accept has no membership to route through
    // `requireRole`, so it needs its own check of the same fact.
    if (inv.org.suspendedAt) return reply.code(403).send({ error: 'organization suspended' });

    const me = await app.prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { email: true } });
    // `inv.email` is always lowercased at creation time, but don't rely on
    // every possible source of `User.email` (an admin seed, an SSO import)
    // having done the same normalization — normalize both sides here.
    if (me.email.toLowerCase() !== inv.email) {
      return reply.code(403).send({ error: 'invite was issued to a different email' });
    }

    const userId = req.user.id;
    const orgId = inv.orgId;
    let result;
    try {
      result = await app.prisma.$transaction(async (tx) => {
        // The org lock comes first, before any insert referencing the org:
        // such an insert takes a KEY SHARE lock on the org row, which this
        // FOR UPDATE conflicts with, so two accepts that each inserted
        // before locking would wait on each other (deadlock). It also
        // serialises this with invites, role changes and app creation.
        await lockOrg(tx, orgId);

        // Acceptance must be single-use even under concurrent requests for
        // the same token (two tabs, a retried request). `updateMany` with
        // the guard in its own `where` is atomic: only one transaction ever
        // sees `count === 1`; every other one is told the invite is gone.
        // (An org deleted meanwhile cascades its invites, so it lands here.)
        const claimed = await tx.invite.updateMany({
          where: { id: inv.id, acceptedAt: null, expiresAt: { gt: new Date() } },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count === 0) throw new InviteGoneError();

        const { row } = await lockOwnersAndTarget(tx, orgId, { userId });
        const role = inv.role;

        if (role === 'OWNER' || role === 'ADMIN') {
          if (!row) {
            await tx.membership.create({ data: { userId, orgId, role } });
          } else if (role === 'ADMIN' && (row.role === 'MEMBER' || row.role === 'VIEWER')) {
            await tx.membership.update({ where: { id: row.id }, data: { role } });
            await tx.appAccess.deleteMany({ where: { userId, app: { orgId } } });
          } else {
            return ALREADY;
          }
        } else {
          if (row && (row.role === 'OWNER' || row.role === 'ADMIN')) return ALREADY;
          const targets = inv.appId !== null
            ? [inv.appId]
            : (await tx.app.findMany({ where: { orgId }, select: { id: true } })).map((a) => a.id);
          if (!row) await tx.membership.create({ data: { userId, orgId, role } });
          const existing = await tx.appAccess.findMany({ where: { userId, appId: { in: targets } }, select: { appId: true, role: true } });
          const current = new Map(existing.map((r) => [r.appId, r.role]));
          const missing = targets.filter((id) => !current.has(id));
          const differing = targets.filter((id) => current.has(id) && current.get(id) !== role);
          if (missing.length) await tx.appAccess.createMany({ data: missing.map((appId) => ({ appId, userId, role })) });
          if (differing.length) await tx.appAccess.updateMany({ where: { userId, appId: { in: differing } }, data: { role } });
          if (row && !missing.length && !differing.length) return ALREADY;
        }
        return { orgId, slug: inv.org.slug, role, ...(inv.appId !== null ? { appId: inv.appId } : {}) };
      });
    } catch (err) {
      if (err instanceof InviteGoneError) {
        return reply.code(410).send({ error: 'invite no longer valid' });
      }
      // Belt-and-braces: the org lock serialises accepts into one org, so a
      // duplicate membership or AppAccess row shouldn't happen; if one ever
      // does, the unique constraints still protect the data and it reads as
      // the same 409, not a 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({ error: 'already a member' });
      }
      throw err;
    }
    if (result === ALREADY) return reply.code(409).send({ error: 'already a member' });
    return result;
  });
}
