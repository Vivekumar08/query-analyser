import { describe, it, expect } from 'vitest';
import { formatTtl, inviteEmail, resetPasswordEmail, verifyEmail } from './templates.js';

const VERIFY = 'https://app.example.test/verify?token=abc_DEF-123';
const RESET = 'https://app.example.test/reset-password?token=r3s3t';
const INVITE = 'https://app.example.test/invite?token=inv1te';

describe('formatTtl', () => {
  it('says hours and days the way people do', () => {
    expect(formatTtl(3600 * 1000)).toBe('1 hour');
    expect(formatTtl(24 * 3600 * 1000)).toBe('24 hours');
    expect(formatTtl(7 * 24 * 3600 * 1000)).toBe('7 days');
    expect(formatTtl(30 * 60 * 1000)).toBe('30 minutes');
  });
});

describe('shared Mist layout', () => {
  const all = [
    verifyEmail({ href: VERIFY, email: 'ada@example.test', ttlMs: 24 * 3600 * 1000 }),
    resetPasswordEmail({ href: RESET, email: 'ada@example.test', ttlMs: 3600 * 1000 }),
    inviteEmail({ href: INVITE, orgName: 'Acme', inviterName: 'Grace', role: 'MEMBER', ttlMs: 7 * 24 * 3600 * 1000 }),
  ];

  it('every email is a full, table-based html document with the wordmark and a text alternative', () => {
    for (const m of all) {
      expect(m.html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(m.html).toContain('<table');
      expect(m.html).toContain('query·analyser');
      expect(m.html).toContain('role="presentation"');
      expect(m.text.length).toBeGreaterThan(40);
      expect(m.text).not.toMatch(/<[a-z]/i);
    }
  });

  it('loads nothing remote: no images, external stylesheets or scripts', () => {
    for (const m of all) {
      expect(m.html).not.toMatch(/<img|<link|<script|@import|url\(/i);
    }
  });

  it('carries a hidden preheader so inbox previews read well', () => {
    for (const m of all) expect(m.html).toMatch(/display:none[^>]*>[^<]{10,}/);
  });
});

describe('verifyEmail', () => {
  const m = verifyEmail({ href: VERIFY, email: 'ada@example.test', ttlMs: 24 * 3600 * 1000 });

  it('keeps the subject', () => expect(m.subject).toBe('Confirm your email'));

  it('puts the link on the button and spelled out, in html and text', () => {
    expect(m.html).toContain(`href="${VERIFY}"`);
    expect(m.html.split(VERIFY).length - 1).toBeGreaterThanOrEqual(2);
    expect(m.text).toContain(VERIFY);
    expect(m.html).toContain('Confirm email');
  });

  it('names the address and the real expiry', () => {
    expect(m.html).toContain('ada@example.test');
    expect(m.html).toContain('expires in 24 hours');
    expect(m.text).toContain('expires in 24 hours');
  });
});

describe('resetPasswordEmail', () => {
  const m = resetPasswordEmail({ href: RESET, email: 'ada@example.test', ttlMs: 3600 * 1000 });

  it('keeps the subject', () => expect(m.subject).toBe('Reset your password'));

  it('links, states the expiry and reassures', () => {
    expect(m.html).toContain(`href="${RESET}"`);
    expect(m.text).toContain(RESET);
    expect(m.html).toContain('expires in 1 hour');
    expect(m.text).toContain('expires in 1 hour');
    expect(m.html).toContain('Your password stays the same');
    expect(m.text).toContain('Your password stays the same');
  });
});

describe('inviteEmail', () => {
  const m = inviteEmail({ href: INVITE, orgName: 'Acme', inviterName: 'Grace Hopper', role: 'ADMIN', ttlMs: 7 * 24 * 3600 * 1000 });

  it('keeps the subject', () => expect(m.subject).toBe("You're invited to Acme on Query Analyser"));

  it('says who invited you, to what, and with which role', () => {
    for (const body of [m.html, m.text]) {
      expect(body).toContain('Grace Hopper');
      expect(body).toContain('Acme');
      expect(body).toContain('Admin');
      expect(body).toContain('expires in 7 days');
      expect(body).toContain(INVITE);
    }
  });

  it('escapes user-controlled names in html and flattens the subject', () => {
    const evil = inviteEmail({
      href: INVITE,
      orgName: '<b>x</b>\r\nBcc: a@b.c',
      inviterName: '<img src=x onerror=alert(1)>',
      role: 'MEMBER',
      ttlMs: 7 * 24 * 3600 * 1000,
    });
    expect(evil.html).not.toContain('<b>x</b>');
    expect(evil.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(evil.html).not.toContain('<img src=x');
    expect(evil.subject).not.toMatch(/[\r\n]/);
    expect(evil.text).not.toMatch(/\r/);
  });

  it('escapes a link that contains html-significant characters', () => {
    const odd = inviteEmail({ href: 'https://x.test/invite?token=a&b="c"', orgName: 'A', inviterName: 'B', role: 'VIEWER', ttlMs: 1 });
    expect(odd.html).toContain('href="https://x.test/invite?token=a&amp;b=&quot;c&quot;"');
  });
});

describe('inviteEmail for an app', () => {
  const base = { href: INVITE, orgName: 'Acme', inviterName: 'Grace Hopper', role: 'MEMBER' as const, ttlMs: 7 * 24 * 3600 * 1000 };

  it('names the app and the org in the subject, preheader and body', () => {
    const m = inviteEmail({ ...base, appName: 'Shop' });
    expect(m.subject).toBe("You're invited to Shop in Acme on Query Analyser");
    expect(m.html).toContain('Grace Hopper invited you to Shop in Acme on Query Analyser.');
    expect(m.html).toContain('<strong');
    expect(m.text).toContain('Grace Hopper invited you to Shop in Acme as Member, to see which MongoDB queries are slowing it down, and why.');
  });

  it('escapes the app name in html and flattens it in the subject', () => {
    const m = inviteEmail({ ...base, appName: 'Shop <b>\r\nBcc: a@b.c' });
    expect(m.html).toContain('Shop &lt;b&gt;');
    expect(m.html).not.toContain('Shop <b>');
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).not.toMatch(/\r/);
  });

  it('without appName, the output is unchanged', () => {
    const withUndefined = inviteEmail({ ...base, appName: undefined });
    const without = inviteEmail(base);
    expect(withUndefined).toEqual(without);
    expect(without.subject).toBe("You're invited to Acme on Query Analyser");
    expect(without.text).toContain('Grace Hopper invited you as Member to see which MongoDB queries are slowing Acme down, and why.');
  });
});
