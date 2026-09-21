import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

const creds = { email: 'a@x.io', password: 'correct horse battery', name: 'A' };
const signup = (c = creds) => app.inject({ method: 'POST', url: '/v1/auth/signup', payload: c });
const login = (c = creds) => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: c.email, password: c.password } });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'qa_refresh')?.value ?? '';

describe('signup', () => {
  it('creates a user, returns an access token and sets a refresh cookie', async () => {
    const res = await signup();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ accessToken: expect.any(String), user: { email: 'a@x.io', name: 'A' } });
    const cookie = res.cookies.find((c) => c.name === 'qa_refresh');
    expect(cookie).toMatchObject({ httpOnly: true, path: '/v1/auth', sameSite: 'Lax' });
    const user = await app.prisma.user.findUniqueOrThrow({ where: { email: 'a@x.io' } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects a duplicate email with 409', async () => {
    await signup();
    expect((await signup()).statusCode).toBe(409);
  });

  it('rejects a short password', async () => {
    expect((await signup({ ...creds, password: 'short' })).statusCode).toBe(400);
  });
});

describe('login', () => {
  it('returns 200 with a token for the right password and 401 for the wrong one', async () => {
    await signup();
    expect((await login()).statusCode).toBe(200);
    expect((await login({ ...creds, password: 'nope-nope-nope' })).statusCode).toBe(401);
  });

  it('401s an unknown email with the same shape as a wrong password', async () => {
    const res = await login({ ...creds, email: 'ghost@x.io' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid credentials' });
  });
});

describe('me', () => {
  it('returns the caller with a valid bearer token and 401 without', async () => {
    const token = (await signup()).json().accessToken as string;
    const ok = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ email: 'a@x.io', isPlatformAdmin: false });
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer junk' } })).statusCode).toBe(401);
  });
});

describe('refresh', () => {
  it('rotates: old cookie is consumed, new cookie works, old cookie is rejected', async () => {
    const first = cookieOf(await signup());
    const r1 = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: first } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ accessToken: expect.any(String) });
    const second = cookieOf(r1);
    expect(second).not.toBe(first);

    const again = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: first } });
    expect(again.statusCode).toBe(401);

    const r2 = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: second } });
    expect(r2.statusCode).toBe(401);   // reuse of `first` revoked the whole family
  });

  it('a stolen token replayed after rotation revokes the family', async () => {
    const t0 = cookieOf(await signup());
    const t1 = cookieOf(await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: t0 } }));
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: t0 } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: t1 } })).statusCode).toBe(401);
    const rows = await app.prisma.refreshToken.findMany();
    expect(rows.every((r) => r.consumedAt !== null)).toBe(true);
  });

  it('401s with no cookie', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh' })).statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('consumes the refresh token and clears the cookie', async () => {
    const t = cookieOf(await signup());
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', cookies: { qa_refresh: t } });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === 'qa_refresh')?.value).toBe('');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: t } })).statusCode).toBe(401);
  });
});
