import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { makeRateLimitKey } from './rate-limit-key.js';

const SECRET = 's'.repeat(40);

describe('makeRateLimitKey', () => {
  const req = (headers: Record<string, string | string[] | undefined>) => ({ ip: '10.0.0.5', headers });

  it('keys on x-qa-client-ip when the proxy secret matches', () => {
    const key = makeRateLimitKey(SECRET);
    expect(key(req({ 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(key(req({ 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': ' 2001:db8::1 ' }))).toBe('2001:db8::1');
  });

  it.each([
    ['a wrong secret of the same length', { 'x-qa-proxy-secret': 't'.repeat(40), 'x-qa-client-ip': '203.0.113.9' }],
    ['a wrong secret of another length', { 'x-qa-proxy-secret': 'short', 'x-qa-client-ip': '203.0.113.9' }],
    ['no secret', { 'x-qa-client-ip': '203.0.113.9' }],
    ['a repeated secret header', { 'x-qa-proxy-secret': [SECRET, SECRET], 'x-qa-client-ip': '203.0.113.9' }],
    ['a matching secret but no client ip', { 'x-qa-proxy-secret': SECRET }],
    ['a matching secret but a non-IP value', { 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': 'evil, 1.2.3.4' }],
  ])('ignores the header and keys on req.ip given %s', (_label, headers) => {
    expect(makeRateLimitKey(SECRET)(req(headers))).toBe('10.0.0.5');
  });

  it('is exactly req.ip when no secret is configured', () => {
    const key = makeRateLimitKey(undefined);
    expect(key(req({ 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': '203.0.113.9' }))).toBe('10.0.0.5');
  });
});

describe('the registered rate limiter (end to end through buildApp)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  async function appWith(secret: string | undefined): Promise<FastifyInstance> {
    const built = await buildApp({ logger: false, config: { ...loadConfig(), WEB_PROXY_SECRET: secret } });
    built.get('/rl-probe', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    return built;
  }
  const hit = (a: FastifyInstance, headers: Record<string, string>) =>
    a.inject({ method: 'GET', url: '/rl-probe', headers }).then((r) => r.statusCode);

  it('with a matching secret, two browsers behind the web server get separate buckets', async () => {
    app = await appWith(SECRET);
    expect(await hit(app, { 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': '203.0.113.1' })).toBe(200);
    expect(await hit(app, { 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': '203.0.113.2' })).toBe(200);
    // ...and one browser is still limited.
    expect(await hit(app, { 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': '203.0.113.1' })).toBe(429);
  });

  it('with a wrong secret, the client-ip header cannot buy a fresh bucket', async () => {
    app = await appWith(SECRET);
    expect(await hit(app, { 'x-qa-proxy-secret': 'x'.repeat(40), 'x-qa-client-ip': '203.0.113.1' })).toBe(200);
    expect(await hit(app, { 'x-qa-proxy-secret': 'x'.repeat(40), 'x-qa-client-ip': '203.0.113.2' })).toBe(429);
  });

  it('with no secret presented, the client-ip header is ignored', async () => {
    app = await appWith(SECRET);
    expect(await hit(app, { 'x-qa-client-ip': '203.0.113.1' })).toBe(200);
    expect(await hit(app, { 'x-qa-client-ip': '203.0.113.2' })).toBe(429);
  });

  it('with WEB_PROXY_SECRET unset, behaviour is unchanged (keys on req.ip)', async () => {
    app = await appWith(undefined);
    expect(await hit(app, { 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': '203.0.113.1' })).toBe(200);
    expect(await hit(app, { 'x-qa-proxy-secret': SECRET, 'x-qa-client-ip': '203.0.113.2' })).toBe(429);
  });
});
