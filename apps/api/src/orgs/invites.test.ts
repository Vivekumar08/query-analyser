import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { settledOrBlocked } from '../test/locks.js';
import { lockOrg } from './locks.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

// Signup (30/min) and invite creation (10/min) are rate-limited per req.ip,
// and every test here shares one in-process app, so give each of those
// requests its own simulated address (as orgs/routes.test.ts does) to keep
// unrelated tests out of each other's buckets.
let ipSeq = 0;
const ip = () => { ipSeq++; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

async function user(email: string) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', remoteAddress: ip(), payload: { email, password: 'correct horse battery', name: email } });
  await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  return { id: s.json().user.id as string, h: { authorization: `Bearer ${s.json().accessToken}` } };
}

describe('invites', () => {
  it('ADMIN+ creates an invite; the invitee accepts and becomes a member', async () => {
    const { o, org, appId } = await orgWithOwner();
    const inv = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } });
    expect(inv.statusCode).toBe(201);
    const { token } = inv.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const list = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/invites`, headers: o.h });
    expect(JSON.stringify(list.json())).not.toContain(token);

    const n = await user('n@x.io');
    const acc = await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'MEMBER', appId });
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);

    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(410);
  });

  it('403s acceptance by a user with a different email', async () => {
    const { o, org, appId } = await orgWithOwner();
    const { token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    const other = await user('other@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: other.h })).statusCode).toBe(403);
  });

  it('410s an expired invite', async () => {
    const { o, org, appId } = await orgWithOwner();
    const { token, id } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    await app.prisma.invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const n = await user('n@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(410);
  });

  it('404s an unknown token and 409s an existing member', async () => {
    const { o, org, appId } = await orgWithOwner();
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${'x'.repeat(43)}/accept`, headers: o.h })).statusCode).toBe(404);
    const { token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'o@x.io', role: 'MEMBER', appId } })).json();
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: o.h })).statusCode).toBe(409);
  });

  // Regression test for the single-use race: the brief's original sample
  // implementation reads `acceptedAt`, then later writes a membership row
  // and marks the invite accepted, as two logically separate steps. Fired
  // concurrently, two accepts of the *same* token can both pass that read
  // before either write lands, so both would succeed and create two
  // memberships. The fix claims the invite atomically (`updateMany` guarded
  // by `acceptedAt: null` in its own `where`), so exactly one of two
  // concurrent accepts must win.
  it('accepts exactly once under two concurrent accepts of the same token', async () => {
    const { o, org, appId } = await orgWithOwner();
    const { token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    const n = await user('n@x.io');

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h }),
      app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 410]);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);
  });

  // Two different, still-valid invites for the same user to the same app,
  // accepted at once: the org lock serialises them, so exactly one grants
  // the access and the other finds it already there (409). Both invites are
  // consumed, so neither lingers in the pending list.
  it('409s one of two concurrent accepts of different invites into the same org for the same user', async () => {
    const { o, org, appId } = await orgWithOwner();
    const { token: t1, id: i1 } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    const { token: t2, id: i2 } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    const n = await user('n@x.io');

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/invites/${t1}/accept`, headers: n.h }),
      app.inject({ method: 'POST', url: `/v1/invites/${t2}/accept`, headers: n.h }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);
    expect(await app.prisma.appAccess.count({ where: { userId: n.id } })).toBe(1);
    expect(await app.prisma.invite.count({ where: { id: { in: [i1, i2] }, acceptedAt: { not: null } } })).toBe(2);
  });

  it('403s acceptance for a suspended org', async () => {
    const { o, org, appId } = await orgWithOwner();
    const { token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    await app.prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });
    const n = await user('n@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(403);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(0);
  });

  it('403s issuing an invite for a suspended org', async () => {
    const { o, org, appId } = await orgWithOwner();
    await app.prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });
    expect((await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).statusCode).toBe(403);
  });
});

describe('invite token log redaction', () => {
  it('never writes the accept token into the request log, even for a failed attempt', async () => {
    const lines: string[] = [];
    const capture = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logApp = await buildApp({ logStream: capture });
    await logApp.ready();

    const token = 'A'.repeat(43);
    // Deliberately unauthenticated: the request log line is written before
    // any preHandler runs, so even a request that never reaches the route
    // handler (401 here) must not have the token appear in the log.
    const res = await logApp.inject({ method: 'POST', url: `/v1/invites/${token}/accept` });
    expect(res.statusCode).toBe(401);

    await logApp.close();

    const combined = lines.join('\n');
    expect(combined).not.toContain(token);
    expect(combined).toContain('/v1/invites/[redacted]/accept');
  });
});

// The org is created through the API (so the owner is a real OWNER member),
// then put on `plan` and given one app, Shop, to invite people to.
async function orgWithOwner(name = 'A', plan = 'team') {
  const o = await user('o@x.io');
  const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name } })).json();
  await app.prisma.organization.update({ where: { id: org.id }, data: { plan } });
  const { id: appId } = await app.prisma.app.create({ data: { orgId: org.id, name: 'Shop', env: 'production' }, select: { id: true } });
  return { o, org, appId };
}

describe('invite rules', () => {
  const invite = (org: { id: string }, h: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: h, payload });

  it('free: a MEMBER invite to an app is accepted; ADMIN and VIEWER are refused as role', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'free');
    const ok = await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().appId).toBe(appId);
    expect(await app.prisma.invite.findUniqueOrThrow({ where: { id: ok.json().id }, select: { appId: true } })).toEqual({ appId });
    for (const payload of [{ email: 'n@x.io', role: 'ADMIN' }, { email: 'n@x.io', role: 'VIEWER', appId }]) {
      const res = await invite(org, o.h, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'plan-limit', limit: 'role', max: 1 });
    }
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('OWNER is never invitable, on any plan', async () => {
    const { o, org } = await orgWithOwner('A', 'team');
    const a = await user('a@x.io');
    await app.prisma.membership.create({ data: { userId: a.id, orgId: org.id, role: 'ADMIN' } });
    for (const [plan, max] of [['team', 3], ['pro', 3], ['free', 1]] as const) {
      await app.prisma.organization.update({ where: { id: org.id }, data: { plan } });
      for (const h of [o.h, a.h]) {
        const res = await invite(org, h, { email: 'n@x.io', role: 'OWNER' });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'plan-limit', limit: 'role', max });
      }
    }
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(0);
  });

  it('400s MEMBER/VIEWER without appId and ADMIN with one', async () => {
    const { o, org, appId } = await orgWithOwner();
    for (const payload of [
      { email: 'n@x.io', role: 'MEMBER' },
      { email: 'n@x.io', role: 'VIEWER', appId: null },
      { email: 'n@x.io', role: 'ADMIN', appId },
    ]) {
      const res = await invite(org, o.h, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid body' });
    }
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(0);
  });

  it("404s another org's app and a nonexistent one alike", async () => {
    const { o, org } = await orgWithOwner();
    const b = await user('b@x.io');
    const orgB = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: b.h, payload: { name: 'B' } })).json();
    const other = await app.prisma.app.create({ data: { orgId: orgB.id, name: 'Other', env: 'production' }, select: { id: true } });
    const foreign = await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId: other.id });
    const missing = await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId: '00000000-0000-0000-0000-000000000000' });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(foreign.json()).toEqual({ error: 'Not Found' });
    expect(missing.json()).toEqual(foreign.json());
    expect(await app.prisma.invite.count()).toBe(0);
  });

  it('free: one seat; adding no person never needs one (Review Focus)', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'free');
    expect((await invite(org, o.h, { email: 'n1@x.io', role: 'MEMBER', appId })).statusCode).toBe(201);
    const full = await invite(org, o.h, { email: 'n2@x.io', role: 'MEMBER', appId });
    expect(full.statusCode).toBe(403);
    expect(full.json()).toEqual({ error: 'plan-limit', limit: 'seats', max: 1 });
    // Re-inviting the pending email (in any case) and inviting the owner add no person.
    expect((await invite(org, o.h, { email: 'N1@x.io', role: 'MEMBER', appId })).statusCode).toBe(201);
    expect((await invite(org, o.h, { email: 'o@x.io', role: 'MEMBER', appId })).statusCode).toBe(201);
    // Revoking both n1 invites frees the seat.
    for (const { id } of await app.prisma.invite.findMany({ where: { orgId: org.id, email: 'n1@x.io' }, select: { id: true } })) {
      expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/invites/${id}`, headers: o.h })).statusCode).toBe(204);
    }
    expect((await invite(org, o.h, { email: 'n2@x.io', role: 'MEMBER', appId })).statusCode).toBe(201);
  });

  it('an expired invite holds no seat', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'free');
    const { id } = (await invite(org, o.h, { email: 'n1@x.io', role: 'MEMBER', appId })).json();
    await app.prisma.invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await invite(org, o.h, { email: 'n2@x.io', role: 'MEMBER', appId })).statusCode).toBe(201);
  });

  it('removing a member frees the seat', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'free');
    const m = await user('m@x.io');
    const mem = await app.prisma.membership.create({ data: { userId: m.id, orgId: org.id, role: 'MEMBER' } });
    const full = await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId });
    expect(full.statusCode).toBe(403);
    expect(full.json()).toEqual({ error: 'plan-limit', limit: 'seats', max: 1 });
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/members/${mem.id}`, headers: o.h })).statusCode).toBe(204);
    expect((await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).statusCode).toBe(201);
  });

  it('an org already over its seats keeps everyone but cannot add a new email', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'free');
    for (const email of ['m1@x.io', 'm2@x.io']) {
      const m = await user(email);
      await app.prisma.membership.create({ data: { userId: m.id, orgId: org.id, role: 'MEMBER' } });
    }
    const full = await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId });
    expect(full.statusCode).toBe(403);
    expect(full.json()).toEqual({ error: 'plan-limit', limit: 'seats', max: 1 });
    // An existing member invited to an app is not a new person.
    expect((await invite(org, o.h, { email: 'M1@x.io', role: 'MEMBER', appId })).statusCode).toBe(201);
    expect(await app.prisma.membership.count({ where: { orgId: org.id } })).toBe(3);
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('two concurrent invites of new emails on free make exactly one invite', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'free');
    const results = await Promise.all(['n1@x.io', 'n2@x.io'].map((email) => invite(org, o.h, { email, role: 'MEMBER', appId })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403]);
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('an invite waits on the org-row lock, then sees the seat taken meanwhile', async () => {
    // In-process Promise.all serialises, so pin the lock: this transaction
    // plays a concurrent invite of a different email, holding the org row.
    // FOR NO KEY UPDATE conflicts with the route's `lockOrg` (FOR UPDATE) but
    // not with the KEY SHARE lock its invite insert takes on the org row, so
    // "blocked" here means the route took the org lock, not just the FK.
    const { o, org, appId } = await orgWithOwner('A', 'free');
    let res: Promise<{ statusCode: number; json: () => unknown }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${org.id} FOR NO KEY UPDATE`;
      res = invite(org, o.h, { email: 'n2@x.io', role: 'MEMBER', appId });
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await tx.invite.create({ data: { orgId: org.id, appId, email: 'n1@x.io', role: 'MEMBER', tokenHash: 'h1', expiresAt: new Date(Date.now() + 3600_000) } });
    });
    const done = await res!;
    expect(done.statusCode).toBe(403);
    expect(done.json()).toEqual({ error: 'plan-limit', limit: 'seats', max: 1 });
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('an invite waits on the org-row lock, then checks the role against the plan as committed', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'team');
    let res: Promise<{ statusCode: number; json: () => unknown }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${org.id} FOR NO KEY UPDATE`;
      res = invite(org, o.h, { email: 'n@x.io', role: 'VIEWER', appId });
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await tx.organization.update({ where: { id: org.id }, data: { plan: 'free' } });
    });
    const done = await res!;
    expect(done.statusCode).toBe(403);
    expect(done.json()).toEqual({ error: 'plan-limit', limit: 'role', max: 1 });
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(0);
  });

  it('lists appId on pending invites', async () => {
    const { o, org, appId } = await orgWithOwner();
    expect((await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).statusCode).toBe(201);
    expect((await invite(org, o.h, { email: 'a@x.io', role: 'ADMIN' })).statusCode).toBe(201);
    const list = (await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/invites`, headers: o.h })).json() as { email: string; appId: string | null }[];
    expect(Object.fromEntries(list.map((i) => [i.email, i.appId]))).toEqual({ 'n@x.io': appId, 'a@x.io': null });
  });
});

describe('invite email', () => {
  it('sends the Mist email naming the inviter and the role', async () => {
    const { o, org } = await orgWithOwner('Acme');
    await app.prisma.user.update({ where: { id: o.id }, data: { name: 'Grace <Hopper>' } });
    const res = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'ADMIN' } });
    expect(res.statusCode).toBe(201);
    const mail = app.sentMail.at(-1)!;
    expect(mail.html).toContain('query·analyser');
    expect(mail.html).toContain('Grace &lt;Hopper&gt;');
    expect(mail.html).not.toContain('Grace <Hopper>');
    expect(mail.text).toContain('Grace <Hopper> invited you as Admin');
  });

  it('names the app and the org', async () => {
    const { o, org, appId } = await orgWithOwner('Acme');
    const res = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } });
    expect(res.statusCode).toBe(201);
    const mail = app.sentMail.at(-1)!;
    expect(mail.subject).toBe("You're invited to Shop in Acme on Query Analyser");
    expect(mail.text).toContain('invited you to Shop in Acme');
  });

  it('mails the invitee one link carrying the returned token', async () => {
    const { o, org } = await orgWithOwner('Acme');
    const before = app.sentMail.length;
    const res = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'N@x.io', role: 'ADMIN' } });
    expect(res.statusCode).toBe(201);
    const { token } = res.json();
    expect(app.sentMail.length).toBe(before + 1);
    const mail = app.sentMail.at(-1)!;
    expect(mail.to).toBe('n@x.io');
    expect(mail.subject).toBe("You're invited to Acme on Query Analyser");
    const link = new URL('/invite', app.config.WEB_ORIGIN);
    link.searchParams.set('token', token);
    expect(mail.text).toContain(link.toString());
    expect(mail.html).toContain(link.toString());
  });

  it('escapes the org name in the html body and strips CR/LF from the subject', async () => {
    const evil = '<b>x</b>\r\nBcc: a@b.c';
    const { o, org, appId } = await orgWithOwner(evil);
    expect(org.name).toBe(evil);
    const res = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } });
    expect(res.statusCode).toBe(201);
    const mail = app.sentMail.at(-1)!;
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain('Bcc: a@b.c'); // flattened onto one line, not a header
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('still returns 201 with the token when the mail send throws', async () => {
    const { o, org, appId } = await orgWithOwner();
    vi.spyOn(app.mailer, 'send').mockRejectedValueOnce(new Error('smtp down'));
    const res = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never logs the token, including when the mail send throws', async () => {
    const lines: string[] = [];
    const capture = new Writable({ write(chunk: Buffer, _enc, cb) { lines.push(chunk.toString()); cb(); } });
    const logApp = await buildApp({ logStream: capture });
    await logApp.ready();
    try {
      const s = await logApp.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'o@x.io', password: 'correct horse battery', name: 'o' } });
      await logApp.prisma.user.update({ where: { email: 'o@x.io' }, data: { emailVerifiedAt: new Date() } });
      const h = { authorization: `Bearer ${s.json().accessToken}` };
      const org = (await logApp.inject({ method: 'POST', url: '/v1/orgs', headers: h, payload: { name: 'A' } })).json();
      const { id: appId } = await logApp.prisma.app.create({ data: { orgId: org.id, name: 'Shop', env: 'production' }, select: { id: true } });
      vi.spyOn(logApp.mailer, 'send').mockRejectedValueOnce(new Error('smtp rejected https://web/invite?token=leak'));
      const res = await logApp.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: h, payload: { email: 'n@x.io', role: 'MEMBER', appId } });
      expect(res.statusCode).toBe(201);
      const { token } = res.json();
      const combined = lines.join('\n');
      expect(combined).toContain('invite mail failed');
      expect(combined).not.toContain(token);
      expect(combined).not.toContain('/invite?token=');
    } finally {
      await logApp.close();
    }
  });
});

describe('invite revoke', () => {
  it('ADMIN revokes a pending invite (204); accepting it afterwards 404s and it leaves the list', async () => {
    const { o, org, appId } = await orgWithOwner();
    const a = await user('a@x.io');
    await app.prisma.membership.create({ data: { userId: a.id, orgId: org.id, role: 'ADMIN' } });
    const { id, token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    const del = await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/invites/${id}`, headers: a.h });
    expect(del.statusCode).toBe(204);
    const list = (await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/invites`, headers: o.h })).json();
    expect(list).toEqual([]);
    const n = await user('n@x.io');
    // A revoked invite is deleted, so accept treats it as unknown: 404.
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/invites/${id}`, headers: a.h })).statusCode).toBe(404);
  });

  it("404s an admin of another org revoking this org's invite, and leaves it intact", async () => {
    const { o, org, appId } = await orgWithOwner();
    const { id } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    const b = await user('b@x.io');
    const orgB = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: b.h, payload: { name: 'B' } })).json();
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${orgB.id}/invites/${id}`, headers: b.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/invites/${id}`, headers: b.h })).statusCode).toBe(404);
    expect(await app.prisma.invite.count({ where: { id } })).toBe(1);
  });

  it('403s a MEMBER revoking', async () => {
    const { o, org, appId } = await orgWithOwner();
    const m = await user('m@x.io');
    await app.prisma.membership.create({ data: { userId: m.id, orgId: org.id, role: 'MEMBER' } });
    const { id } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json();
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/invites/${id}`, headers: m.h })).statusCode).toBe(403);
    expect(await app.prisma.invite.count({ where: { id } })).toBe(1);
  });

  it('404s revoking an accepted or expired invite, or an unknown id', async () => {
    const { o, org, appId } = await orgWithOwner();
    const mk = async () => (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } })).json().id as string;
    const accepted = await mk();
    await app.prisma.invite.update({ where: { id: accepted }, data: { acceptedAt: new Date() } });
    const expired = await mk();
    await app.prisma.invite.update({ where: { id: expired }, data: { expiresAt: new Date(Date.now() - 1000) } });
    for (const id of [accepted, expired, 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/invites/${id}`, headers: o.h })).statusCode).toBe(404);
    }
    expect(await app.prisma.invite.count({ where: { id: { in: [accepted, expired] } } })).toBe(2);
  });
});

describe('invite creation limits', () => {
  it('429s the 11th invite created within a minute from one address, and sends no mail for it', async () => {
    const { o, org, appId } = await orgWithOwner();
    const addr = '192.0.2.77';
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', remoteAddress: addr, url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: `n${i}@x.io`, role: 'MEMBER', appId } });
      expect(r.statusCode).toBe(201);
    }
    const before = app.sentMail.length;
    const r = await app.inject({ method: 'POST', remoteAddress: addr, url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n10@x.io', role: 'MEMBER', appId } });
    expect(r.statusCode).toBe(429);
    expect(app.sentMail.length).toBe(before);
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(10);
  });

  it('states the expiry in the mail from the invite TTL', async () => {
    const { o, org, appId } = await orgWithOwner();
    const r = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER', appId } });
    const days = Math.round((new Date(r.json().expiresAt).getTime() - Date.now()) / 86_400_000);
    const mail = app.sentMail.at(-1)!;
    expect(mail.text).toContain(`expires in ${days} days`);
    expect(mail.html).toContain(`expires in ${days} days`);
  });
});

describe('accept', () => {
  const invite = (org: { id: string }, h: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: h, payload });
  const accept = (token: string, h: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: h });
  const rows = async (userId: string) =>
    (await app.prisma.appAccess.findMany({ where: { userId }, select: { role: true, app: { select: { name: true } } }, orderBy: { app: { name: 'asc' } } }))
      .map((r) => [r.app.name, r.role]);
  const membershipRole = async (orgId: string, userId: string) =>
    (await app.prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true } }))?.role;
  const secondApp = async (orgId: string) =>
    (await app.prisma.app.create({ data: { orgId, name: 'Admin panel', env: 'production' }, select: { id: true } })).id;
  // An invite written straight to the table, as a pre-deploy (legacy) invite
  // with no appId would be.
  let legacySeq = 0;
  const legacyInvite = async (orgId: string, email: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER') => {
    const token = `legacy-${++legacySeq}-${'t'.repeat(32)}`;
    const { id } = await app.prisma.invite.create({
      data: { orgId, email, role, appId: null, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) },
      select: { id: true },
    });
    return { token, id };
  };

  it('a new user joins as MEMBER with access to that app only', async () => {
    const { o, org, appId } = await orgWithOwner();
    await secondApp(org.id);
    const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).json();
    const n = await user('n@x.io');
    const res = await accept(token, n.h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'MEMBER', appId });
    expect(await membershipRole(org.id, n.id)).toBe('MEMBER');
    expect(await rows(n.id)).toEqual([['Shop', 'MEMBER']]);
  });

  it('an app-scoped member invited to a second app keeps their membership and gains it with the invite role', async () => {
    const { o, org, appId } = await orgWithOwner();
    const admin = await secondApp(org.id);
    const n = await user('n@x.io');
    await app.prisma.membership.create({ data: { userId: n.id, orgId: org.id, role: 'VIEWER' } });
    await app.prisma.appAccess.create({ data: { userId: n.id, appId, role: 'VIEWER' } });
    const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId: admin })).json();
    const res = await accept(token, n.h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'MEMBER', appId: admin });
    expect(await membershipRole(org.id, n.id)).toBe('VIEWER');
    expect(await rows(n.id)).toEqual([['Admin panel', 'MEMBER'], ['Shop', 'VIEWER']]);
  });

  it('the same access again is 409 and still consumes the invite (Review Focus)', async () => {
    const { o, org, appId } = await orgWithOwner();
    const n = await user('n@x.io');
    await app.prisma.membership.create({ data: { userId: n.id, orgId: org.id, role: 'MEMBER' } });
    await app.prisma.appAccess.create({ data: { userId: n.id, appId, role: 'MEMBER' } });
    const { token, id } = (await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).json();
    const res = await accept(token, n.h);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already a member' });
    expect((await app.prisma.invite.findUniqueOrThrow({ where: { id } })).acceptedAt).not.toBeNull();
    const list = (await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/invites`, headers: o.h })).json() as { id: string }[];
    expect(list.map((i) => i.id)).not.toContain(id);
    expect((await accept(token, n.h)).statusCode).toBe(410);
    expect(await rows(n.id)).toEqual([['Shop', 'MEMBER']]);
  });

  it('a row with a different role is set to the invite role', async () => {
    const { o, org, appId } = await orgWithOwner();
    const n = await user('n@x.io');
    await app.prisma.membership.create({ data: { userId: n.id, orgId: org.id, role: 'VIEWER' } });
    await app.prisma.appAccess.create({ data: { userId: n.id, appId, role: 'VIEWER' } });
    const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).json();
    const res = await accept(token, n.h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'MEMBER', appId });
    expect(await membershipRole(org.id, n.id)).toBe('VIEWER');
    expect(await rows(n.id)).toEqual([['Shop', 'MEMBER']]);
  });

  it('an OWNER or ADMIN accepting an app invite is 409 and the invite is consumed', async () => {
    const { o, org, appId } = await orgWithOwner();
    const a = await user('a@x.io');
    await app.prisma.membership.create({ data: { userId: a.id, orgId: org.id, role: 'ADMIN' } });
    for (const [who, email, role] of [[o, 'o@x.io', 'OWNER'], [a, 'a@x.io', 'ADMIN']] as const) {
      const { token, id } = (await invite(org, o.h, { email, role: 'MEMBER', appId })).json();
      const res = await accept(token, who.h);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'already a member' });
      expect((await app.prisma.invite.findUniqueOrThrow({ where: { id } })).acceptedAt).not.toBeNull();
      expect(await membershipRole(org.id, who.id)).toBe(role);
      expect(await rows(who.id)).toEqual([]);
    }
  });

  it('an ADMIN invite promotes an existing MEMBER and drops their rows', async () => {
    const { o, org, appId } = await orgWithOwner();
    const admin = await secondApp(org.id);
    const n = await user('n@x.io');
    await app.prisma.membership.create({ data: { userId: n.id, orgId: org.id, role: 'MEMBER' } });
    await app.prisma.appAccess.createMany({ data: [{ userId: n.id, appId, role: 'MEMBER' }, { userId: n.id, appId: admin, role: 'VIEWER' }] });
    // A row in another org is untouched.
    const b = await user('b@x.io');
    const orgB = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: b.h, payload: { name: 'B' } })).json();
    const other = await app.prisma.app.create({ data: { orgId: orgB.id, name: 'Other', env: 'production' }, select: { id: true } });
    await app.prisma.membership.create({ data: { userId: n.id, orgId: orgB.id, role: 'MEMBER' } });
    await app.prisma.appAccess.create({ data: { userId: n.id, appId: other.id, role: 'MEMBER' } });

    const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'ADMIN' })).json();
    const res = await accept(token, n.h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'ADMIN' });
    expect(await membershipRole(org.id, n.id)).toBe('ADMIN');
    expect(await rows(n.id)).toEqual([['Other', 'MEMBER']]);
  });

  it('an ADMIN invite to an existing ADMIN or OWNER is 409 and changes nothing', async () => {
    const { o, org } = await orgWithOwner();
    const a = await user('a@x.io');
    await app.prisma.membership.create({ data: { userId: a.id, orgId: org.id, role: 'ADMIN' } });
    for (const [who, email, role] of [[o, 'o@x.io', 'OWNER'], [a, 'a@x.io', 'ADMIN']] as const) {
      const { token, id } = (await invite(org, o.h, { email, role: 'ADMIN' })).json();
      const res = await accept(token, who.h);
      expect(res.statusCode).toBe(409);
      expect((await app.prisma.invite.findUniqueOrThrow({ where: { id } })).acceptedAt).not.toBeNull();
      expect(await membershipRole(org.id, who.id)).toBe(role);
    }
  });

  it('a legacy MEMBER invite (appId null) grants every app in the org', async () => {
    const { org } = await orgWithOwner();
    await secondApp(org.id);
    const { token } = await legacyInvite(org.id, 'n@x.io', 'MEMBER');
    const n = await user('n@x.io');
    const res = await accept(token, n.h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'MEMBER' });
    expect(await membershipRole(org.id, n.id)).toBe('MEMBER');
    expect(await rows(n.id)).toEqual([['Admin panel', 'MEMBER'], ['Shop', 'MEMBER']]);
  });

  it('a legacy VIEWER invite to an existing member adds the apps they lack', async () => {
    const { org, appId } = await orgWithOwner();
    await secondApp(org.id);
    const n = await user('n@x.io');
    await app.prisma.membership.create({ data: { userId: n.id, orgId: org.id, role: 'VIEWER' } });
    await app.prisma.appAccess.create({ data: { userId: n.id, appId, role: 'VIEWER' } });
    const { token } = await legacyInvite(org.id, 'n@x.io', 'VIEWER');
    expect((await accept(token, n.h)).statusCode).toBe(200);
    expect(await rows(n.id)).toEqual([['Admin panel', 'VIEWER'], ['Shop', 'VIEWER']]);
    // Everything already there: 409.
    const again = await legacyInvite(org.id, 'n@x.io', 'VIEWER');
    expect((await accept(again.token, n.h)).statusCode).toBe(409);
  });

  it('a legacy OWNER invite accepts as before', async () => {
    const { org } = await orgWithOwner();
    const { token } = await legacyInvite(org.id, 'n@x.io', 'OWNER');
    const n = await user('n@x.io');
    const res = await accept(token, n.h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'OWNER' });
    expect(await membershipRole(org.id, n.id)).toBe('OWNER');
    expect(await rows(n.id)).toEqual([]);

    const m = await user('m@x.io');
    await app.prisma.membership.create({ data: { userId: m.id, orgId: org.id, role: 'MEMBER' } });
    const forM = await legacyInvite(org.id, 'm@x.io', 'OWNER');
    const res2 = await accept(forM.token, m.h);
    expect(res2.statusCode).toBe(409);
    expect((await app.prisma.invite.findUniqueOrThrow({ where: { id: forM.id } })).acceptedAt).not.toBeNull();
    expect(await membershipRole(org.id, m.id)).toBe('MEMBER');
  });

  it('an existing MEMBER row is lowered to VIEWER by a VIEWER invite to that app', async () => {
    const { o, org, appId } = await orgWithOwner();
    const n = await user('n@x.io');
    await app.prisma.membership.create({ data: { userId: n.id, orgId: org.id, role: 'MEMBER' } });
    await app.prisma.appAccess.create({ data: { userId: n.id, appId, role: 'MEMBER' } });
    const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'VIEWER', appId })).json();
    const res = await accept(token, n.h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'VIEWER', appId });
    expect(await membershipRole(org.id, n.id)).toBe('MEMBER');
    expect(await rows(n.id)).toEqual([['Shop', 'VIEWER']]);
  });

  describe('the role is re-checked against the plan at accept (app invites only)', () => {
    const refused = { error: 'plan-limit', limit: 'role', max: 1 };

    it('a VIEWER app invite issued on team is refused after the org drops to free, and is consumed', async () => {
      const { o, org, appId } = await orgWithOwner();
      const { token, id } = (await invite(org, o.h, { email: 'n@x.io', role: 'VIEWER', appId })).json();
      await app.prisma.organization.update({ where: { id: org.id }, data: { plan: 'free' } });
      const n = await user('n@x.io');
      const res = await accept(token, n.h);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(refused);
      expect((await app.prisma.invite.findUniqueOrThrow({ where: { id } })).acceptedAt).not.toBeNull();
      expect(await membershipRole(org.id, n.id)).toBeUndefined();
      expect(await rows(n.id)).toEqual([]);
      expect((await accept(token, n.h)).statusCode).toBe(410);
    });

    it('a VIEWER app invite to an existing MEMBER on free is refused before the 409/role decisions, row unchanged', async () => {
      const { o, org, appId } = await orgWithOwner();
      const n = await user('n@x.io');
      await app.prisma.membership.create({ data: { userId: n.id, orgId: org.id, role: 'MEMBER' } });
      await app.prisma.appAccess.create({ data: { userId: n.id, appId, role: 'MEMBER' } });
      const { token, id } = (await invite(org, o.h, { email: 'n@x.io', role: 'VIEWER', appId })).json();
      await app.prisma.organization.update({ where: { id: org.id }, data: { plan: 'free' } });
      const res = await accept(token, n.h);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(refused);
      expect((await app.prisma.invite.findUniqueOrThrow({ where: { id } })).acceptedAt).not.toBeNull();
      expect(await rows(n.id)).toEqual([['Shop', 'MEMBER']]);
    });

    it('a MEMBER app invite on free accepts', async () => {
      const { o, org, appId } = await orgWithOwner('A', 'free');
      const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).json();
      const n = await user('n@x.io');
      const res = await accept(token, n.h);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'MEMBER', appId });
      expect(await rows(n.id)).toEqual([['Shop', 'MEMBER']]);
    });

    it('legacy OWNER and ADMIN invites (appId null) are honoured as issued on free', async () => {
      const { org } = await orgWithOwner('A', 'free');
      for (const [email, role] of [['n1@x.io', 'OWNER'], ['n2@x.io', 'ADMIN']] as const) {
        const { token } = await legacyInvite(org.id, email, role);
        const u = await user(email);
        const res = await accept(token, u.h);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role });
        expect(await membershipRole(org.id, u.id)).toBe(role);
      }
    });
  });

  describe('a legacy MEMBER/VIEWER invite grants only apps that existed when it was issued', () => {
    // Shop is backdated, the invite is issued now, and Admin panel is created
    // a minute later, so the ordering never depends on clock resolution.
    async function setup() {
      const { org, appId } = await orgWithOwner();
      await app.prisma.app.update({ where: { id: appId }, data: { createdAt: new Date(Date.now() - 60_000) } });
      const legacy = await legacyInvite(org.id, 'n@x.io', 'MEMBER');
      const newer = (await app.prisma.app.create({ data: { orgId: org.id, name: 'Admin panel', env: 'production', createdAt: new Date(Date.now() + 60_000) }, select: { id: true } })).id;
      return { org, appId, newer, ...legacy };
    }

    it('a newcomer gets only the older app', async () => {
      const { org, token } = await setup();
      const n = await user('n@x.io');
      const res = await accept(token, n.h);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'MEMBER' });
      expect(await rows(n.id)).toEqual([['Shop', 'MEMBER']]);
    });

    it('an existing member who already holds the older app gets 409, the invite is consumed, and no newer row', async () => {
      const { org, appId, token, id } = await setup();
      const n = await user('n@x.io');
      await app.prisma.membership.create({ data: { userId: n.id, orgId: org.id, role: 'MEMBER' } });
      await app.prisma.appAccess.create({ data: { userId: n.id, appId, role: 'MEMBER' } });
      const res = await accept(token, n.h);
      expect(res.statusCode).toBe(409);
      expect((await app.prisma.invite.findUniqueOrThrow({ where: { id } })).acceptedAt).not.toBeNull();
      expect(await rows(n.id)).toEqual([['Shop', 'MEMBER']]);
    });
  });

  it('an invite to a deleted app 404s', async () => {
    const { o, org, appId } = await orgWithOwner();
    const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).json();
    await app.prisma.app.delete({ where: { id: appId } });
    const n = await user('n@x.io');
    expect((await accept(token, n.h)).statusCode).toBe(404);
    expect(await membershipRole(org.id, n.id)).toBeUndefined();
  });

  it('waits on the org lock', async () => {
    // FOR NO KEY UPDATE conflicts with the route's `lockOrg` (FOR UPDATE) but
    // not with the KEY SHARE lock a membership insert takes on the org row,
    // so "blocked" means the route took the org lock itself.
    const { o, org, appId } = await orgWithOwner();
    const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).json();
    const n = await user('n@x.io');
    let res: Promise<{ statusCode: number }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${org.id} FOR NO KEY UPDATE`;
      res = accept(token, n.h);
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
    });
    expect((await res!).statusCode).toBe(200);
  });

  it('two accepts into the same org by different people both complete, without deadlock', async () => {
    // Each accept inserts rows referencing the org (a KEY SHARE lock on its
    // row) and takes the org lock (FOR UPDATE). Taking the org lock first is
    // what keeps two of them from each waiting on the other's KEY SHARE.
    const { o, org, appId } = await orgWithOwner();
    const people = ['n1@x.io', 'n2@x.io', 'n3@x.io'];
    const tokens: string[] = [];
    for (const email of people) tokens.push((await invite(org, o.h, { email, role: 'MEMBER', appId })).json().token as string);
    const users = await Promise.all(people.map((email) => user(email)));
    const results = await Promise.all(users.map((u, i) => accept(tokens[i]!, u.h)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await app.prisma.membership.count({ where: { orgId: org.id } })).toBe(4);
    expect(await app.prisma.appAccess.count({ where: { appId } })).toBe(3);
  });

  it('an accept holding the org lock does not deadlock against a concurrent one', async () => {
    // Pin the interleaving that deadlocks when an accept inserts before it
    // locks the org: this transaction plays an accept that has inserted a
    // membership (KEY SHARE on the org row) and then asks for the org lock.
    const { o, org, appId } = await orgWithOwner();
    const { token } = (await invite(org, o.h, { email: 'n@x.io', role: 'MEMBER', appId })).json();
    const n = await user('n@x.io');
    const m = await user('m@x.io');
    let res: Promise<{ statusCode: number }> | undefined;
    await app.prisma.$transaction(async (tx) => {
      await tx.membership.create({ data: { userId: m.id, orgId: org.id, role: 'MEMBER' } });
      res = accept(token, n.h);
      expect(await settledOrBlocked(app.prisma, res, tx)).toBe('blocked');
      await lockOrg(tx, org.id);
    });
    expect((await res!).statusCode).toBe(200);
  });
});
