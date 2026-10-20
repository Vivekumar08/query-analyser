import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { generateSampleKeyPair, wrapPrivateKey, type WrappedKey } from '@query-analyser/contract';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

const b64 = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
const rand = (n: number) => b64(crypto.getRandomValues(new Uint8Array(n)));

/**
 * A wrapped-key record shaped like the browser's. The API cannot (and must
 * not) check the ciphertext, so random bytes of the right lengths stand in
 * for a real 600 000-iteration wrap and keep the suite fast.
 */
function wrapped(over: Partial<WrappedKey> = {}): WrappedKey {
  return { v: 1, salt: rand(16), iv: rand(12), iterations: 600_000, ciphertext: rand(154), ...over };
}

async function verifiedUser(email: string) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: 'correct horse battery', name: 'U' } });
  await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  return { id: s.json().user.id as string, h: { authorization: `Bearer ${s.json().accessToken}` } };
}

async function setup() {
  const o = await verifiedUser('o@x.io');
  const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'Acme' } })).json();
  const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
  const member = async (email: string, role: 'ADMIN' | 'MEMBER' | 'VIEWER') => {
    const u = await verifiedUser(email);
    await app.prisma.membership.create({ data: { userId: u.id, orgId: org.id, role } });
    if (role !== 'ADMIN') await app.prisma.appAccess.create({ data: { appId: a.id, userId: u.id, role } });
    return u.h;
  };
  return { ownerH: o.h, appId: a.id as string, member };
}

const url = (appId: string) => `/v1/apps/${appId}/sample-key`;

async function seedSignatureWithSample(appId: string, hash = 'a'.repeat(16)) {
  return app.prisma.querySignature.create({
    data: {
      appId, hash, signature: 'S', model: 'M', operation: 'find', filterShape: [], sortKeys: [], stages: [],
      encryptedSample: { v: 1, epk: rand(65), iv: rand(12), ct: rand(40) },
    },
  });
}

describe('sample key routes', () => {
  it('GET returns { enabled: false } when no key is set, and works for a VIEWER', async () => {
    const { appId, member } = await setup();
    const viewer = await member('v@x.io', 'VIEWER');
    const res = await app.inject({ method: 'GET', url: url(appId), headers: viewer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });

  it('PUT by an ADMIN sets the key; GET then returns the public key and the wrapped record to a VIEWER', async () => {
    const { appId, member } = await setup();
    const admin = await member('a@x.io', 'ADMIN');
    const viewer = await member('v@x.io', 'VIEWER');
    const { publicKey } = await generateSampleKeyPair();
    const w = wrapped();

    const put = await app.inject({ method: 'PUT', url: url(appId), headers: admin, payload: { publicKey, wrapped: w } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ enabled: true, publicKey });

    const row = await app.prisma.app.findUniqueOrThrow({ where: { id: appId } });
    expect(row.samplePublicKey).toBe(publicKey);
    expect(row.sampleKeyWrapped).toEqual(w);

    const get = await app.inject({ method: 'GET', url: url(appId), headers: viewer });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ enabled: true, publicKey, wrapped: w });
  });

  it('PUT accepts a real key pair wrapped by the contract at the production iteration count', async () => {
    const { appId, ownerH } = await setup();
    const pair = await generateSampleKeyPair();
    const w = await wrapPrivateKey(pair.privateKey, 'correct horse battery staple');
    const res = await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey: pair.publicKey, wrapped: w } });
    expect(res.statusCode).toBe(200);
  });

  it('PUT by a MEMBER gives 403 and stores nothing', async () => {
    const { appId, member } = await setup();
    const m = await member('m@x.io', 'MEMBER');
    const { publicKey } = await generateSampleKeyPair();
    const res = await app.inject({ method: 'PUT', url: url(appId), headers: m, payload: { publicKey, wrapped: wrapped() } });
    expect(res.statusCode).toBe(403);
    expect((await app.prisma.app.findUniqueOrThrow({ where: { id: appId } })).samplePublicKey).toBeNull();
  });

  it('PUT with a key that is not P-256 gives 400', async () => {
    const { appId, ownerH } = await setup();
    const p384 = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits']);
    const publicKey = b64(await crypto.subtle.exportKey('spki', p384.publicKey));
    const res = await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey, wrapped: wrapped() } });
    expect(res.statusCode).toBe(400);
    expect((await app.prisma.app.findUniqueOrThrow({ where: { id: appId } })).samplePublicKey).toBeNull();
  });

  it('PUT with garbage that is valid base64 but not a key gives 400', async () => {
    const { appId, ownerH } = await setup();
    const res = await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey: rand(91), wrapped: wrapped() } });
    expect(res.statusCode).toBe(400);
  });

  it('PUT with iterations below 600 000 gives 400', async () => {
    const { appId, ownerH } = await setup();
    const { publicKey } = await generateSampleKeyPair();
    const res = await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey, wrapped: wrapped({ iterations: 1000 }) } });
    expect(res.statusCode).toBe(400);
    expect((await app.prisma.app.findUniqueOrThrow({ where: { id: appId } })).samplePublicKey).toBeNull();
  });

  it.each([
    ['an unknown wrap version', { v: 2 }],
    ['an oversized ciphertext', { ciphertext: 'A'.repeat(2000) }],
    ['a non-base64 salt', { salt: 'not base64!' }],
    ['an oversized iv', { iv: 'A'.repeat(64) }],
  ])('PUT with %s gives 400', async (_label, over) => {
    const { appId, ownerH } = await setup();
    const { publicKey } = await generateSampleKeyPair();
    const res = await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey, wrapped: { ...wrapped(), ...over } } });
    expect(res.statusCode).toBe(400);
  });

  it('PUT with an oversized public key gives 400', async () => {
    const { appId, ownerH } = await setup();
    const res = await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey: 'A'.repeat(304), wrapped: wrapped() } });
    expect(res.statusCode).toBe(400);
  });

  it('PUT on rotation clears previously stored encrypted samples for this app only', async () => {
    const { appId, ownerH } = await setup();
    const first = await generateSampleKeyPair();
    expect((await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey: first.publicKey, wrapped: wrapped() } })).statusCode).toBe(200);
    const sig = await seedSignatureWithSample(appId);

    const org2 = await app.prisma.organization.create({ data: { name: 'Other', slug: 'other' } });
    const other = await app.prisma.app.create({ data: { orgId: org2.id, name: 'x', env: 'p' } });
    const otherSig = await seedSignatureWithSample(other.id);

    const second = await generateSampleKeyPair();
    const res = await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey: second.publicKey, wrapped: wrapped() } });
    expect(res.statusCode).toBe(200);
    expect((await app.prisma.querySignature.findUniqueOrThrow({ where: { id: sig.id } })).encryptedSample).toBeNull();
    expect((await app.prisma.querySignature.findUniqueOrThrow({ where: { id: otherSig.id } })).encryptedSample).not.toBeNull();
    expect((await app.prisma.app.findUniqueOrThrow({ where: { id: appId } })).samplePublicKey).toBe(second.publicKey);
  });

  it('DELETE by an ADMIN clears the key and every encrypted sample', async () => {
    const { appId, ownerH, member } = await setup();
    const admin = await member('a@x.io', 'ADMIN');
    const { publicKey } = await generateSampleKeyPair();
    await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey, wrapped: wrapped() } });
    const sig = await seedSignatureWithSample(appId);

    const del = await app.inject({ method: 'DELETE', url: url(appId), headers: admin });
    expect(del.statusCode).toBe(204);

    const row = await app.prisma.app.findUniqueOrThrow({ where: { id: appId } });
    expect(row.samplePublicKey).toBeNull();
    expect(row.sampleKeyWrapped).toBeNull();
    expect((await app.prisma.querySignature.findUniqueOrThrow({ where: { id: sig.id } })).encryptedSample).toBeNull();
    expect((await app.inject({ method: 'GET', url: url(appId), headers: ownerH })).json()).toEqual({ enabled: false });
  });

  it('DELETE by a MEMBER gives 403 and keeps the key', async () => {
    const { appId, ownerH, member } = await setup();
    const m = await member('m@x.io', 'MEMBER');
    const { publicKey } = await generateSampleKeyPair();
    await app.inject({ method: 'PUT', url: url(appId), headers: ownerH, payload: { publicKey, wrapped: wrapped() } });
    expect((await app.inject({ method: 'DELETE', url: url(appId), headers: m })).statusCode).toBe(403);
    expect((await app.prisma.app.findUniqueOrThrow({ where: { id: appId } })).samplePublicKey).toBe(publicKey);
  });

  it('404s for a caller outside the org', async () => {
    const { appId } = await setup();
    const stranger = await verifiedUser('s@x.io');
    expect((await app.inject({ method: 'GET', url: url(appId), headers: stranger.h })).statusCode).toBe(404);
  });
});
