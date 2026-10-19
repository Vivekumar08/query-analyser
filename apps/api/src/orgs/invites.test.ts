import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Writable } from 'node:stream';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
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
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const inv = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } });
    expect(inv.statusCode).toBe(201);
    const { token } = inv.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const list = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/invites`, headers: o.h });
    expect(JSON.stringify(list.json())).not.toContain(token);

    const n = await user('n@x.io');
    const acc = await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toEqual({ orgId: org.id, role: 'MEMBER' });
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);

    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(410);
  });

  it('403s acceptance by a user with a different email', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    const other = await user('other@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: other.h })).statusCode).toBe(403);
  });

  it('410s an expired invite', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token, id } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    await app.prisma.invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const n = await user('n@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(410);
  });

  it('ADMIN cannot invite an OWNER; OWNER can', async () => {
    const o = await user('o@x.io'); const a = await user('a@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    await app.prisma.membership.create({ data: { userId: a.id, orgId: org.id, role: 'ADMIN' } });
    expect((await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: a.h, payload: { email: 'n@x.io', role: 'OWNER' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'OWNER' } })).statusCode).toBe(201);
  });

  it('404s an unknown token and 409s an existing member', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${'x'.repeat(43)}/accept`, headers: o.h })).statusCode).toBe(404);
    const { token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'o@x.io', role: 'MEMBER' } })).json();
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
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    const n = await user('n@x.io');

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h }),
      app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 410]);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);
  });

  // Covers the P2002 fallback at the bottom of the accept route's catch
  // block: the pre-transaction `already` check only guards against the
  // *same* invite being accepted twice by the same user for the same org —
  // it doesn't stop two different, still-valid invites into the *same* org
  // for the same user racing each other's membership-create. Fire both
  // concurrently and require that exactly one becomes a member (either via
  // the pre-check 409 or the P2002-mapped 409), never two memberships.
  it('409s one of two concurrent accepts of different invites into the same org for the same user', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token: t1 } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    const { token: t2 } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'VIEWER' } })).json();
    const n = await user('n@x.io');

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/invites/${t1}/accept`, headers: n.h }),
      app.inject({ method: 'POST', url: `/v1/invites/${t2}/accept`, headers: n.h }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);
  });

  it('403s acceptance for a suspended org', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    await app.prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });
    const n = await user('n@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(403);
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(0);
  });

  it('403s issuing an invite for a suspended org', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    await app.prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });
    expect((await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).statusCode).toBe(403);
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

async function orgWithOwner(name = 'A') {
  const o = await user('o@x.io');
  const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name } })).json();
  return { o, org };
}

describe('invite email', () => {
  it('mails the invitee one link carrying the returned token', async () => {
    const { o, org } = await orgWithOwner('Acme');
    const before = app.sentMail.length;
    const res = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'N@x.io', role: 'MEMBER' } });
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
    const { o, org } = await orgWithOwner(evil);
    expect(org.name).toBe(evil);
    const res = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } });
    expect(res.statusCode).toBe(201);
    const mail = app.sentMail.at(-1)!;
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain('Bcc: a@b.c'); // flattened onto one line, not a header
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('still returns 201 with the token when the mail send throws', async () => {
    const { o, org } = await orgWithOwner();
    vi.spyOn(app.mailer, 'send').mockRejectedValueOnce(new Error('smtp down'));
    const res = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } });
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
      vi.spyOn(logApp.mailer, 'send').mockRejectedValueOnce(new Error('smtp rejected https://web/invite?token=leak'));
      const res = await logApp.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: h, payload: { email: 'n@x.io', role: 'MEMBER' } });
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
    const { o, org } = await orgWithOwner();
    const a = await user('a@x.io');
    await app.prisma.membership.create({ data: { userId: a.id, orgId: org.id, role: 'ADMIN' } });
    const { id, token } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
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
    const { o, org } = await orgWithOwner();
    const { id } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    const b = await user('b@x.io');
    const orgB = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: b.h, payload: { name: 'B' } })).json();
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${orgB.id}/invites/${id}`, headers: b.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/invites/${id}`, headers: b.h })).statusCode).toBe(404);
    expect(await app.prisma.invite.count({ where: { id } })).toBe(1);
  });

  it('403s a MEMBER revoking', async () => {
    const { o, org } = await orgWithOwner();
    const m = await user('m@x.io');
    await app.prisma.membership.create({ data: { userId: m.id, orgId: org.id, role: 'MEMBER' } });
    const { id } = (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/invites/${id}`, headers: m.h })).statusCode).toBe(403);
    expect(await app.prisma.invite.count({ where: { id } })).toBe(1);
  });

  it('404s revoking an accepted or expired invite, or an unknown id', async () => {
    const { o, org } = await orgWithOwner();
    const mk = async () => (await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json().id as string;
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
    const { o, org } = await orgWithOwner();
    const addr = '192.0.2.77';
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', remoteAddress: addr, url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: `n${i}@x.io`, role: 'MEMBER' } });
      expect(r.statusCode).toBe(201);
    }
    const before = app.sentMail.length;
    const r = await app.inject({ method: 'POST', remoteAddress: addr, url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n10@x.io', role: 'MEMBER' } });
    expect(r.statusCode).toBe(429);
    expect(app.sentMail.length).toBe(before);
    expect(await app.prisma.invite.count({ where: { orgId: org.id } })).toBe(10);
  });

  it('409s a 51st pending invite and sends no mail; accepted/expired invites and a re-invite of a pending email do not count', async () => {
    const { o, org } = await orgWithOwner();
    const future = new Date(Date.now() + 3600_000);
    await app.prisma.invite.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({ orgId: org.id, email: `p${i}@x.io`, role: 'MEMBER' as const, tokenHash: `h${i}`, expiresAt: future })),
    });
    const before = app.sentMail.length;
    const over = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'new@x.io', role: 'MEMBER' } });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('Too many pending invites — revoke some first.');
    expect(app.sentMail.length).toBe(before);
    expect(await app.prisma.invite.count({ where: { orgId: org.id, email: 'new@x.io' } })).toBe(0);

    // Re-inviting an address that already has a pending invite keeps working
    // at the cap (it adds no new pending invitee).
    const again = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'P0@x.io', role: 'MEMBER' } });
    expect(again.statusCode).toBe(201);
    expect(app.sentMail.length).toBe(before + 1);

    // Only pending invites count: free two slots by expiring one and accepting another.
    await app.prisma.invite.updateMany({ where: { orgId: org.id, email: 'p1@x.io' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await app.prisma.invite.updateMany({ where: { orgId: org.id, email: 'p2@x.io' }, data: { acceptedAt: new Date() } });
    expect((await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'new@x.io', role: 'MEMBER' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'new2@x.io', role: 'MEMBER' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'new3@x.io', role: 'MEMBER' } })).statusCode).toBe(409);
  });

  it('states the expiry in the mail from the invite TTL', async () => {
    const { o, org } = await orgWithOwner();
    const r = await app.inject({ method: 'POST', remoteAddress: ip(), url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } });
    const days = Math.round((new Date(r.json().expiresAt).getTime() - Date.now()) / 86_400_000);
    const mail = app.sentMail.at(-1)!;
    expect(mail.text).toContain(`expires in ${days} days`);
    expect(mail.html).toContain(`expires in ${days} days`);
  });
});
