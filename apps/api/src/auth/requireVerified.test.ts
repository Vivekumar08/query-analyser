import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
});

async function unverified(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'U' },
  });
  return res.json().accessToken as string;
}

async function verify(email: string) {
  await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
}

describe('requireVerified', () => {
  it('403s an unverified user on a gated route', async () => {
    const email = `g1-${Date.now()}@x.io`;
    const token = await unverified(email);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'email not verified' });
  });

  it('lets the same user through once verified', async () => {
    const email = `g2-${Date.now()}@x.io`;
    const token = await unverified(email);
    await verify(email);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Yes' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('never gates the auth routes, or an unverified user cannot verify', async () => {
    const email = `g3-${Date.now()}@x.io`;
    const token = await unverified(email);

    const resend = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify/request',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resend.statusCode).toBe(202);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('never gates ingest — a key belongs to an app, not to a human', async () => {
    // One unverified teammate must not stop a customer's data flowing.
    const email = `g4-${Date.now()}@x.io`;
    const token = await unverified(email);
    await verify(email);

    const org = (
      await app.inject({
        method: 'POST',
        url: '/v1/orgs',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ingest Co' },
      })
    ).json();
    const appRow = (
      await app.inject({
        method: 'POST',
        url: `/v1/orgs/${org.id}/apps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'ing', env: 'production' },
      })
    ).json();
    const key = (
      await app.inject({
        method: 'POST',
        url: `/v1/apps/${appRow.id}/keys`,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().key as string;

    // Now un-verify the owner. Ingest must be unaffected.
    await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: null } });

    const bucket = new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        app: 'ing',
        env: 'production',
        host: 'h',
        sdkVersion: '0.1.0',
        bucket,
        thresholdMs: 0,
        dropped: 0,
        items: [
          {
            signature: 'users.find({email})',
            hash: 'abcdef0123456789',
            model: 'users',
            operation: 'find',
            filterShape: [],
            sortKeys: [],
            stages: [],
            count: 1,
            totalMs: 10,
            maxMs: 10,
            lastMs: 10,
            lastTs: Date.now(),
            hist: [1, 0, 0, 0, 0, 0, 0, 0],
            sample: null,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
  });
});
