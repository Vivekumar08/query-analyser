import { describe, it, expect, afterEach } from 'vitest';
import { rejectCrossSiteAuthPost } from './same-origin-guard';

const original = process.env.WEB_ORIGIN;
afterEach(() => {
  if (original === undefined) delete process.env.WEB_ORIGIN;
  else process.env.WEB_ORIGIN = original;
});

function post(headers: Record<string, string>): Request {
  // The URL host is the bind address on purpose: the guard must never
  // consult request.url.
  return new Request('http://0.0.0.0:3000/api/auth/login', { method: 'POST', headers, body: '{}' });
}

describe('rejectCrossSiteAuthPost with WEB_ORIGIN set', () => {
  const good = { 'content-type': 'application/json', origin: 'https://qa.example.com' };

  it('lets a same-origin JSON POST through', () => {
    process.env.WEB_ORIGIN = 'https://qa.example.com';
    expect(rejectCrossSiteAuthPost(post(good))).toBeNull();
  });

  it('accepts a charset parameter on the JSON content type', () => {
    process.env.WEB_ORIGIN = 'https://qa.example.com/';
    expect(rejectCrossSiteAuthPost(post({ ...good, 'content-type': 'application/json; charset=utf-8' }))).toBeNull();
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'rejects a %s body (what a cross-site HTML form can send) with 403',
    async (ct) => {
      process.env.WEB_ORIGIN = 'https://qa.example.com';
      const res = rejectCrossSiteAuthPost(post({ ...good, 'content-type': ct }));
      expect(res?.status).toBe(403);
    },
  );

  it('rejects a missing content type', () => {
    process.env.WEB_ORIGIN = 'https://qa.example.com';
    expect(rejectCrossSiteAuthPost(post({ origin: good.origin }))?.status).toBe(403);
  });

  it.each(['https://evil.example', 'http://qa.example.com', 'https://qa.example.com.evil.example', 'null'])(
    'rejects a foreign Origin (%s) with 403',
    (origin) => {
      process.env.WEB_ORIGIN = 'https://qa.example.com';
      expect(rejectCrossSiteAuthPost(post({ ...good, origin }))?.status).toBe(403);
    },
  );

  it('rejects a missing Origin with 403', () => {
    process.env.WEB_ORIGIN = 'https://qa.example.com';
    expect(rejectCrossSiteAuthPost(post({ 'content-type': 'application/json' }))?.status).toBe(403);
  });

  it('ignores a matching Host when WEB_ORIGIN says otherwise', () => {
    process.env.WEB_ORIGIN = 'https://qa.example.com';
    const res = rejectCrossSiteAuthPost(post({ ...good, origin: 'https://evil.example', host: 'evil.example' }));
    expect(res?.status).toBe(403);
  });

  it('fails closed on a malformed WEB_ORIGIN', () => {
    process.env.WEB_ORIGIN = 'not a url';
    expect(rejectCrossSiteAuthPost(post({ ...good, host: 'qa.example.com' }))?.status).toBe(403);
  });
});

describe('rejectCrossSiteAuthPost without WEB_ORIGIN (dev fallback)', () => {
  it('lets a JSON POST through when Origin host equals Host', () => {
    delete process.env.WEB_ORIGIN;
    const res = rejectCrossSiteAuthPost(post({
      'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
    }));
    expect(res).toBeNull();
  });

  it('rejects when Origin host differs from Host', () => {
    delete process.env.WEB_ORIGIN;
    const res = rejectCrossSiteAuthPost(post({
      'content-type': 'application/json', origin: 'http://evil.example', host: 'localhost:3000',
    }));
    expect(res?.status).toBe(403);
  });

  it('rejects a missing Origin', () => {
    delete process.env.WEB_ORIGIN;
    const res = rejectCrossSiteAuthPost(post({ 'content-type': 'application/json', host: 'localhost:3000' }));
    expect(res?.status).toBe(403);
  });
});
