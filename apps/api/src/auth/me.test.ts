import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';
import { rotateRefreshToken } from './tokens.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

// Signup, login and the password route are rate-limited per `req.ip`, and the
// limiter's store lives as long as the app (the whole file). Every request
// that hits a limited route gets its own simulated address, so no test can
// 429 another — except the rate-limit test, which shares one on purpose.
let nextIp = 1;
const ip = () => `10.1.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a-completely-new-password-1';

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'qa_refresh')?.value ?? '';
const as = (token: string) => ({ authorization: `Bearer ${token}` });

async function user(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    remoteAddress: ip(),
    payload: { email, password: PASSWORD, name: email },
  });
  await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  return { id: res.json().user.id as string, token: res.json().accessToken as string, cookie: cookieOf(res) };
}

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress: ip(), payload: { email, password } });
const refresh = (cookie: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: cookie } });
const patchMe = (token: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url: '/v1/me', headers: as(token), payload: payload as object });
const changePassword = (token: string, payload: unknown, remoteAddress = ip()) =>
  app.inject({ method: 'POST', url: '/v1/me/password', remoteAddress, headers: as(token), payload: payload as object });

describe('PATCH /v1/me', () => {
  it('trims and saves the name and returns the GET /v1/me shape', async () => {
    const u = await user('a@x.io');
    const res = await patchMe(u.token, { name: '  Ada  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: u.id, email: 'a@x.io', name: 'Ada', isPlatformAdmin: false, emailVerifiedAt: expect.any(String) });

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: as(u.token) });
    expect(me.json()).toEqual(res.json());
  });

  it('ignores unknown fields', async () => {
    const u = await user('a@x.io');
    const res = await patchMe(u.token, { name: 'Ada', email: 'evil@x.io', isPlatformAdmin: true });
    expect(res.statusCode).toBe(200);
    const row = await app.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row).toMatchObject({ name: 'Ada', email: 'a@x.io', isPlatformAdmin: false });
  });

  it('400s a blank or over-long name', async () => {
    const u = await user('a@x.io');
    for (const payload of [{ name: '   ' }, { name: 'x'.repeat(101) }, {}]) {
      const res = await patchMe(u.token, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid body' });
    }
    expect((await patchMe(u.token, { name: 'x'.repeat(100) })).statusCode).toBe(200);
    const row = await app.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.name).toBe('x'.repeat(100));
  });

  it('401s without a token', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/me', payload: { name: 'Ada' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/me/password', () => {
  it('403s a wrong current password with wrong-password', async () => {
    const u = await user('a@x.io');
    const res = await changePassword(u.token, { currentPassword: 'not the password', newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'wrong-password' });
    // nothing changed: the old password still logs in, the session still refreshes
    expect((await login('a@x.io', PASSWORD)).statusCode).toBe(200);
    expect((await refresh(u.cookie)).statusCode).toBe(200);
  });

  it('400s a new password under 12 chars and one equal to the current', async () => {
    const u = await user('a@x.io');
    const short = await changePassword(u.token, { currentPassword: PASSWORD, newPassword: 'short-pass1' });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toEqual({ error: 'invalid body' });

    const same = await changePassword(u.token, { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.statusCode).toBe(400);
    expect(same.json()).toEqual({ error: 'new password must differ from the current one' });

    const missing = await changePassword(u.token, { newPassword: NEW_PASSWORD });
    expect(missing.statusCode).toBe(400);

    expect((await login('a@x.io', PASSWORD)).statusCode).toBe(200);
  });

  it('changes the password, revokes every refresh token, and issues a working session', async () => {
    const u = await user('a@x.io');
    // a second device
    const other = cookieOf(await login('a@x.io', PASSWORD));
    expect(other).not.toBe('');

    const res = await changePassword(u.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accessToken: expect.any(String), user: { id: u.id, email: 'a@x.io', name: 'a@x.io', isPlatformAdmin: false } });
    expect(Object.keys(res.json()).sort()).toEqual(['accessToken', 'user']);
    const fresh = cookieOf(res);
    expect(res.cookies.find((c) => c.name === 'qa_refresh')).toMatchObject({ httpOnly: true, path: '/v1/auth' });
    expect(await app.prisma.refreshToken.count({ where: { userId: u.id, consumedAt: null } })).toBe(1);

    // the new access token works
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: as(res.json().accessToken) });
    expect(me.statusCode).toBe(200);

    // the old cookies are dead
    expect((await refresh(u.cookie)).statusCode).toBe(401);
    expect((await refresh(other)).statusCode).toBe(401);
    // replaying them did not take the new session down with them
    const r1 = await refresh(fresh);
    expect(r1.statusCode).toBe(200);
    expect((await refresh(cookieOf(r1))).statusCode).toBe(200);

    // the new password logs in; the old one does not
    expect((await login('a@x.io', NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login('a@x.io', PASSWORD)).statusCode).toBe(401);
  });

  it('401s a still-valid access token whose user row was deleted, and changes no password', async () => {
    const gone = await user('gone@x.io');
    const bystander = await user('b@x.io');
    const before = await app.prisma.user.findUniqueOrThrow({ where: { id: bystander.id }, select: { passwordHash: true } });
    await app.prisma.refreshToken.deleteMany({ where: { userId: gone.id } });
    await app.prisma.user.delete({ where: { id: gone.id } });

    const res = await changePassword(gone.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    expect(res.cookies.find((c) => c.name === 'qa_refresh')).toBeUndefined();
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: bystander.id }, select: { passwordHash: true } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await app.prisma.refreshToken.count({ where: { userId: gone.id } })).toBe(0);
  });

  it('leaves no live refresh token from before the change when a refresh straddles it', async () => {
    const u = await user('a@x.io');
    let change: Promise<{ statusCode: number; cookies: { name: string; value: string }[] }> | undefined;
    // The rotation has consumed the old token but not yet stored its
    // successor when the password change starts. Give the change up to a
    // second to finish; if it is (correctly) blocked behind the rotation,
    // let the rotation go on and the change completes after it.
    const rotated = await rotateRefreshToken(app.prisma, u.cookie, {
      afterConsume: async () => {
        change = changePassword(u.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
        await Promise.race([change, new Promise((r) => setTimeout(r, 1000))]);
      },
    });
    const res = await change!;
    expect(res.statusCode).toBe(200);
    expect(rotated).toMatchObject({ userId: u.id });

    // Only the change's own session is live; the rotation's successor is not.
    expect(await app.prisma.refreshToken.count({ where: { userId: u.id, consumedAt: null } })).toBe(1);
    if (typeof rotated !== 'string') expect((await refresh(rotated.token)).statusCode).toBe(401);
    expect((await refresh(cookieOf(res))).statusCode).toBe(200);
  });

  it('kills an outstanding reset link', async () => {
    const u = await user('a@x.io');
    const mailBefore = app.sentMail.length;
    const req = await app.inject({ method: 'POST', url: '/v1/auth/password/request', remoteAddress: ip(), payload: { email: 'a@x.io' } });
    expect(req.statusCode).toBe(202);
    const deadline = Date.now() + 5000;
    while (app.sentMail.length <= mailBefore) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the reset mail');
      await new Promise((r) => setTimeout(r, 10));
    }
    const resetToken = /token=([A-Za-z0-9_-]+)/.exec(app.sentMail.at(-1)!.text)![1];

    expect((await changePassword(u.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).statusCode).toBe(200);

    const confirm = await app.inject({
      method: 'POST', url: '/v1/auth/password/confirm',
      payload: { token: resetToken, password: 'an-attackers-password-1' },
    });
    expect(confirm.statusCode).toBe(400);
    expect((await login('a@x.io', NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('rate-limits to 10 a minute', async () => {
    const u = await user('a@x.io');
    const addr = '10.9.9.9';
    for (let i = 0; i < 10; i++) {
      const res = await changePassword(u.token, { currentPassword: 'not the password', newPassword: NEW_PASSWORD }, addr);
      expect(res.statusCode).toBe(403);
    }
    const blocked = await changePassword(u.token, { currentPassword: 'not the password', newPassword: NEW_PASSWORD }, addr);
    expect(blocked.statusCode).toBe(429);
  });

  it('401s without a token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/me/password', remoteAddress: ip(),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });
});
