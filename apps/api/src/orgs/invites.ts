import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { requireRole } from './rbac.js';
import { Prisma } from '../generated/prisma/client.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const INVITE_TTL_DAYS = Math.round(INVITE_TTL_MS / (24 * 3600 * 1000));
// Every invite now sends mail from the product's sender, so creation is
// throttled like the other mail-sending routes (auth/routes.ts), and an org
// can hold at most this many distinct pending invitees (Ruling C9-1).
const MAX_PENDING_INVITES = 50;
const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
const createSchema = z.object({ email: z.string().email().max(200), role: z.enum(ROLES) });
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// The org name is user-controlled and lands in an HTML body and a mail
// header, so escape it for the former and flatten it for the latter (a CR/LF
// in a subject is a header-injection vector even if nodemailer folds it).
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

// Sentinel thrown inside the acceptance transaction when the invite was
// consumed (or expired) between the pre-transaction read and the atomic
// claim below, and mapped to a 410 outside it — mirroring the LastOwnerError
// pattern in orgs/routes.ts.
class InviteGoneError extends Error {}

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/orgs/:org/invites', {
    preHandler: [app.authenticate, app.requireVerified, requireRole('ADMIN')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    // Privilege-escalation gate: an ADMIN who could mint an OWNER invite
    // (and then accept it themselves via a second account, or hand it to an
    // ally) could promote past their own rank. Only an existing OWNER may
    // invite another OWNER.
    if (parsed.data.role === 'OWNER' && req.membership.role !== 'OWNER') {
      return reply.code(403).send({ error: 'only an owner can invite an owner' });
    }
    const email = parsed.data.email.toLowerCase();
    // Count distinct pending invitees, not rows: re-inviting an address that
    // already has a pending invite adds a second row (unchanged behaviour)
    // but no new invitee, so it is never refused by the cap. Check-then-insert
    // can overshoot by a few under concurrent creates, which the rate limit
    // above bounds; the cap is a mail-abuse brake, not an invariant.
    const pending = { orgId: req.membership.orgId, acceptedAt: null, expiresAt: { gt: new Date() } };
    const alreadyPending = await app.prisma.invite.findFirst({ where: { ...pending, email }, select: { id: true } });
    if (!alreadyPending) {
      const invitees = await app.prisma.invite.findMany({ where: pending, distinct: ['email'], select: { email: true } });
      if (invitees.length >= MAX_PENDING_INVITES) {
        return reply.code(409).send({ error: 'Too many pending invites — revoke some first.' });
      }
    }
    const token = randomBytes(32).toString('base64url');
    const row = await app.prisma.invite.create({
      data: {
        orgId: req.membership.orgId,
        email,
        role: parsed.data.role,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      select: { id: true, email: true, role: true, expiresAt: true, org: { select: { name: true } } },
    });
    const { org, ...invite } = row;

    // A mail failure must never fail the invite: the admin still gets the
    // token below and can copy the link by hand. `mailer.send` swallows SMTP
    // errors itself, but guard anyway, and log only the error's name — the
    // message could quote the link, and the link carries the token.
    const link = new URL('/invite', app.config.WEB_ORIGIN);
    link.searchParams.set('token', token);
    const href = link.toString();
    try {
      await app.mailer.send({
        to: invite.email,
        subject: oneLine(`You're invited to ${org.name} on Query Analyser`),
        text: `You've been invited to join ${oneLine(org.name)} on Query Analyser.\n\nAccept the invite:\n\n${href}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
        html: `<p>You've been invited to join <strong>${escapeHtml(org.name)}</strong> on Query Analyser.</p><p><a href="${escapeHtml(href)}">Accept the invite</a></p><p>Or paste this link into your browser:<br>${escapeHtml(href)}</p><p>This link expires in ${INVITE_TTL_DAYS} days.</p>`,
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
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
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
  // else, and every failure mode below (404 unknown, 410 expired/used, 403
  // wrong email, 409 already a member) is checked before any write.
  app.post('/v1/invites/:token/accept', { preHandler: [app.authenticate, app.requireVerified] }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const inv = await app.prisma.invite.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { org: { select: { suspendedAt: true } } },
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

    const already = await app.prisma.membership.findUnique({
      where: { userId_orgId: { userId: req.user.id, orgId: inv.orgId } },
    });
    if (already) return reply.code(409).send({ error: 'already a member' });

    try {
      return await app.prisma.$transaction(async (tx) => {
        // Acceptance must be single-use even under concurrent requests for
        // the same token (two tabs, a retried request). A plain
        // check-then-write (read acceptedAt, then write) has exactly the
        // race this repo was bitten by in Task 8's last-OWNER bug: two
        // concurrent transactions could both observe acceptedAt === null
        // and both proceed to create a membership. `updateMany` with the
        // guard in its `where` clause is atomic — Postgres takes the row
        // lock on the UPDATE itself, so only one concurrent transaction can
        // ever see `count === 1`; every other one gets `count === 0` and is
        // told the invite is gone, without any explicit `FOR UPDATE`.
        const claimed = await tx.invite.updateMany({
          where: { id: inv.id, acceptedAt: null, expiresAt: { gt: new Date() } },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count === 0) throw new InviteGoneError();

        await tx.membership.create({ data: { userId: req.user.id, orgId: inv.orgId, role: inv.role } });
        return { orgId: inv.orgId, role: inv.role };
      });
    } catch (err) {
      if (err instanceof InviteGoneError) {
        return reply.code(410).send({ error: 'invite no longer valid' });
      }
      // Belt-and-braces: if a concurrent accept of a *different* invite to
      // the same org somehow raced past the `already` check above, the
      // membership unique constraint still protects the data — report it
      // the same way the pre-check does, as 409, rather than 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({ error: 'already a member' });
      }
      throw err;
    }
  });
}
