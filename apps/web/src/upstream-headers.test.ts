import { describe, it, expect, afterEach } from 'vitest';
import { upstreamAuthHeaders } from './upstream-headers';

const original = process.env.WEB_PROXY_SECRET;
afterEach(() => {
  if (original === undefined) delete process.env.WEB_PROXY_SECRET;
  else process.env.WEB_PROXY_SECRET = original;
});

const req = (headers: Record<string, string> = {}) => new Request('http://0.0.0.0:3000/api/auth/login', { headers });

describe('upstreamAuthHeaders', () => {
  it('forwards the first X-Forwarded-For hop as x-qa-client-ip', () => {
    const h = upstreamAuthHeaders(req({ 'x-forwarded-for': ' 203.0.113.9 , 10.0.0.2' }));
    expect(h.get('x-qa-client-ip')).toBe('203.0.113.9');
  });

  it('sends no client ip when there is no X-Forwarded-For', () => {
    expect(upstreamAuthHeaders(req()).has('x-qa-client-ip')).toBe(false);
    expect(upstreamAuthHeaders(req({ 'x-forwarded-for': ' , ' })).has('x-qa-client-ip')).toBe(false);
  });

  it('sends WEB_PROXY_SECRET as x-qa-proxy-secret when set, and nothing when unset', () => {
    process.env.WEB_PROXY_SECRET = 'p'.repeat(32);
    expect(upstreamAuthHeaders(req()).get('x-qa-proxy-secret')).toBe('p'.repeat(32));
    delete process.env.WEB_PROXY_SECRET;
    expect(upstreamAuthHeaders(req()).has('x-qa-proxy-secret')).toBe(false);
  });

  it('keeps caller headers, and caller headers cannot override the forwarded pair', () => {
    process.env.WEB_PROXY_SECRET = 'p'.repeat(32);
    const h = upstreamAuthHeaders(req({ 'x-forwarded-for': '203.0.113.9' }), {
      'content-type': 'application/json',
      'x-qa-client-ip': '1.1.1.1',
      'x-qa-proxy-secret': 'nope',
    });
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('x-qa-client-ip')).toBe('203.0.113.9');
    expect(h.get('x-qa-proxy-secret')).toBe('p'.repeat(32));
  });

  it('never forwards the incoming request\'s own x-qa-* headers', () => {
    delete process.env.WEB_PROXY_SECRET;
    const h = upstreamAuthHeaders(req({ 'x-qa-client-ip': '6.6.6.6', 'x-qa-proxy-secret': 'forged' }));
    expect(h.has('x-qa-client-ip')).toBe(false);
    expect(h.has('x-qa-proxy-secret')).toBe(false);
  });
});
