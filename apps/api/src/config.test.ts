import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgresql://qa:qa@localhost:5432/qa',
  JWT_SECRET: 'x'.repeat(32),
  COOKIE_SECRET: 'y'.repeat(32),
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'user',
  SMTP_PASS: 'pass',
  WEB_ORIGIN: 'https://app.example.com',
};

describe('loadConfig', () => {
  it('parses SMTP_SECURE "false" and "true" to real booleans, not truthy strings', () => {
    const off = loadConfig({ ...base, SMTP_SECURE: 'false' });
    expect(off.SMTP_SECURE).toBe(false);

    const on = loadConfig({ ...base, SMTP_SECURE: 'true' });
    expect(on.SMTP_SECURE).toBe(true);
  });

  it('rejects an SMTP_SECURE value that is neither "true" nor "false"', () => {
    // z.coerce.boolean() would silently turn 'false' into true; this is the
    // trap that bug class sets, pinned here so a future "simplification"
    // breaks a test instead of breaking production TLS on port 587.
    expect(() => loadConfig({ ...base, SMTP_SECURE: 'yes' })).toThrow();
  });

  it('throws naming the missing paths when SMTP_HOST, SMTP_USER and SMTP_PASS are absent', () => {
    const { SMTP_HOST, SMTP_USER, SMTP_PASS, ...withoutSmtp } = base;
    void SMTP_HOST;
    void SMTP_USER;
    void SMTP_PASS;

    let message = '';
    try {
      loadConfig(withoutSmtp);
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('SMTP_HOST');
    expect(message).toContain('SMTP_USER');
    expect(message).toContain('SMTP_PASS');
  });

  it('throws naming WEB_ORIGIN when it is missing (no default, per the deploy-order fix)', () => {
    const { WEB_ORIGIN, ...withoutWebOrigin } = base;
    void WEB_ORIGIN;

    let message = '';
    try {
      loadConfig(withoutWebOrigin);
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('WEB_ORIGIN');
  });

  it('treats an empty WEB_PROXY_SECRET as unset, and rejects a short one', () => {
    expect(loadConfig({ ...base }).WEB_PROXY_SECRET).toBeUndefined();
    expect(loadConfig({ ...base, WEB_PROXY_SECRET: '' }).WEB_PROXY_SECRET).toBeUndefined();
    expect(loadConfig({ ...base, WEB_PROXY_SECRET: 'p'.repeat(32) }).WEB_PROXY_SECRET).toBe('p'.repeat(32));
    expect(() => loadConfig({ ...base, WEB_PROXY_SECRET: 'too-short' })).toThrow(/WEB_PROXY_SECRET/);
  });

  describe('RETENTION_GRACE_UNTIL', () => {
    it('defaults to 2027-01-31 UTC when unset or empty', () => {
      expect(loadConfig(base).RETENTION_GRACE_UNTIL.toISOString()).toBe('2027-01-31T00:00:00.000Z');
      expect(loadConfig({ ...base, RETENTION_GRACE_UNTIL: '' }).RETENTION_GRACE_UNTIL.toISOString())
        .toBe('2027-01-31T00:00:00.000Z');
    });

    it('parses an ISO date', () => {
      expect(loadConfig({ ...base, RETENTION_GRACE_UNTIL: '2026-12-01' }).RETENTION_GRACE_UNTIL.toISOString())
        .toBe('2026-12-01T00:00:00.000Z');
    });

    it.each(['soon', '2027-01-31T00:00:00Z', '2027-02-30', '2027-13-01', '31/01/2027', '1'])('rejects %j, naming the variable', (v) => {
      expect(() => loadConfig({ ...base, RETENTION_GRACE_UNTIL: v })).toThrow(/RETENTION_GRACE_UNTIL/);
    });
  });
});
