import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildApp, parseTrustProxy } from './app.js';
import { loadConfig } from './config.js';
import { resetDb } from './test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
afterAll(async () => { await app.close(); });

describe('health', () => {
  it('answers 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('404s unknown routes as JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not Found' });
  });
});

describe('parseTrustProxy', () => {
  it("maps the literal 'true'/'false' strings to booleans", () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('passes anything else through unchanged (e.g. a CIDR/IP list)', () => {
    expect(parseTrustProxy('10.0.0.0/8,127.0.0.1')).toBe('10.0.0.0/8,127.0.0.1');
  });
});

describe('trustProxy defaults and enforcement', () => {
  it("loadConfig defaults TRUST_PROXY to 'false' when unset", () => {
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: 'postgresql://qa:qa@localhost:5432/qa',
      JWT_SECRET: 'x'.repeat(32),
      COOKIE_SECRET: 'x'.repeat(32),
      TRUST_PROXY: undefined,
    });
    expect(config.TRUST_PROXY).toBe('false');
  });

  it('does not trust a forged X-Forwarded-For when TRUST_PROXY=false', async () => {
    const config = { ...loadConfig(), TRUST_PROXY: 'false' };
    const untrusted = await buildApp({ logger: false, config });
    let observedIp: string | undefined;
    untrusted.addHook('onRequest', (req, _reply, done) => {
      observedIp = req.ip;
      done();
    });

    const res = await untrusted.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    expect(res.statusCode).toBe(200);
    expect(observedIp).not.toBe('203.0.113.9');
    await untrusted.close();
  });

  it('trusts X-Forwarded-For when TRUST_PROXY=true', async () => {
    const config = { ...loadConfig(), TRUST_PROXY: 'true' };
    const trusted = await buildApp({ logger: false, config });
    let observedIp: string | undefined;
    trusted.addHook('onRequest', (req, _reply, done) => {
      observedIp = req.ip;
      done();
    });

    const res = await trusted.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    expect(res.statusCode).toBe(200);
    expect(observedIp).toBe('203.0.113.9');
    await trusted.close();
  });
});

describe('error handler resilience', () => {
  let errApp: FastifyInstance;

  beforeAll(async () => {
    errApp = await buildApp({ logger: false });
    errApp.get('/throw-null', () => {
      throw null; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    errApp.get('/throw-string', () => {
      throw 'boom';
    });
    errApp.get('/throw-object', () => {
      throw { statusCode: 400, message: 'nope' };
    });
  });

  afterAll(async () => { await errApp.close(); });

  it('does not crash and masks a thrown null as a 500', async () => {
    const res = await errApp.inject({ method: 'GET', url: '/throw-null' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
  });

  it('does not crash and masks a thrown string as a 500', async () => {
    const res = await errApp.inject({ method: 'GET', url: '/throw-string' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
  });

  it('passes the message through for a thrown error-like object with a 4xx status', async () => {
    const res = await errApp.inject({ method: 'GET', url: '/throw-object' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'nope' });
  });
});

describe('BigInt reply serialization', () => {
  it('serializes a stray BigInt in a reply instead of throwing', async () => {
    const bigIntApp = await buildApp({ logger: false });
    bigIntApp.get('/bigint', () => ({ totalMs: 9007199254740993n }));

    const res = await bigIntApp.inject({ method: 'GET', url: '/bigint' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ totalMs: '9007199254740993' });

    await bigIntApp.close();
  });
});

// Pinning tests: the three set* calls below (setReplySerializer,
// setNotFoundHandler, setErrorHandler) must apply to routes declared
// *inside* a registered plugin (every real `/v1` route), not only to
// routes declared directly on the root instance. Fastify snapshots
// `kErrorHandler`/`kReplySerializerDefault` into a child encapsulation
// context the moment its `register()` call resolves — a `set*` made after
// that point never reaches it. The tests above exercise the root instance
// only (`/healthz`, and routes added straight on `app`/`errApp`/`bigIntApp`
// without going through `register()`), which is exactly the one context
// that stayed green through the whole bug. These hit real `/v1` routes
// that are registered via `app.register(...)` inside `buildApp`, so they
// fail if the three `set*` calls above ever move back below the
// `register(...)` block.
describe('custom error handler and reply serializer apply to /v1 routes', () => {
  let v1App: FastifyInstance;

  beforeAll(async () => { v1App = await buildApp({ logger: false }); });
  beforeEach(async () => { await resetDb(v1App.prisma); });
  afterAll(async () => { await v1App.close(); });

  it('malformed JSON on a real /v1 route gets the custom {error} shape, not Fastify\'s default body', async () => {
    const res = await v1App.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    // Fastify's own default error reply is
    // `{"statusCode":400,"code":"FST_ERR_CTP_INVALID_JSON_BODY","error":"Bad Request","message":"..."}`.
    // Our handler always replies with exactly one key, `error`.
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.code).toBeUndefined();
    expect(body.statusCode).toBeUndefined();
  });

  it('a thrown/rejected error on a real /v1 route does not leak its message', async () => {
    // A dedicated, throwaway app instance: mocking a method off Prisma's
    // proxy-based client object does not cleanly un-mock afterwards (even
    // with `restoreMocks`/`mockRestore`), so this must not share `v1App`
    // with tests that go on to make real `user.findUnique` calls.
    const throwApp = await buildApp({ logger: false });
    vi.spyOn(throwApp.prisma.user, 'findUnique').mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.4.17:5432'),
    );

    const res = await throwApp.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    expect(JSON.stringify(res.json())).not.toMatch(/ECONNREFUSED|10\.0\.4\.17/);

    await throwApp.close();
  });

  it('a BigInt reaching a real /v1 route reply serializes instead of throwing', async () => {
    const u = await v1App.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'root@example.com', password: 'correct horse battery', name: 'Root' },
    });
    await v1App.prisma.user.update({ where: { email: 'root@example.com' }, data: { isPlatformAdmin: true } });
    const headers = { authorization: `Bearer ${(u.json() as { accessToken: string }).accessToken}` };

    const original = v1App.ingestStats.batches;
    // `/v1/admin/health` replies with `app.ingestStats` verbatim — stand in
    // for a rollup's BigInt `totalMs` reaching a real reply without pulling
    // in Postgres BigInt columns just for this test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v1App.ingestStats as any).batches = 9007199254740993n;

    try {
      const res = await v1App.inject({ method: 'GET', url: '/v1/admin/health', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ batches: '9007199254740993' });
    } finally {
      v1App.ingestStats.batches = original;
    }
  });
});
