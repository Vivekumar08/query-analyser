import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, parseTrustProxy } from './app.js';
import { loadConfig } from './config.js';
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
