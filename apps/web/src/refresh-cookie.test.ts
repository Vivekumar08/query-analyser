import { describe, it, expect } from 'vitest';
import {
  rescopeRefreshCookie,
  readRefreshFromSetCookie,
  forwardRefreshCookie,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
} from './refresh-cookie.js';

describe('rescopeRefreshCookie', () => {
  it('changes Path=/v1/auth to Path=/api/auth', () => {
    const input = 'qa_refresh=abc; Path=/v1/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600';
    const out = rescopeRefreshCookie(input);
    expect(out).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(out).not.toContain('Path=/v1/auth');
  });

  it('preserves HttpOnly, Secure, SameSite and Max-Age verbatim', () => {
    const input = 'qa_refresh=abc; Path=/v1/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600';
    const out = rescopeRefreshCookie(input);
    expect(out).toContain('HttpOnly');
    expect(out).toContain('Secure');
    expect(out).toContain('SameSite=Lax');
    expect(out).toContain('Max-Age=1209600');
  });

  it('handles a lowercase path= attribute', () => {
    const input = 'qa_refresh=abc; path=/v1/auth; HttpOnly';
    const out = rescopeRefreshCookie(input);
    expect(out).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(out.toLowerCase()).not.toContain('path=/v1/auth');
  });

  it('appends Path=/api/auth when the cookie has no Path at all', () => {
    const input = 'qa_refresh=abc; HttpOnly; Secure';
    const out = rescopeRefreshCookie(input);
    expect(out).toContain(`Path=${REFRESH_COOKIE_PATH}`);
  });

  it('returns the input unchanged when it is empty or has no name/value pair', () => {
    // Unreachable via forwardRefreshCookie (which name-matches first), but
    // the function is exported standalone, so a malformed "; Path=..."
    // string must not be produced here.
    expect(rescopeRefreshCookie('')).toBe('');
    expect(rescopeRefreshCookie('HttpOnly; Secure')).toBe('HttpOnly; Secure');
  });
});

describe('readRefreshFromSetCookie', () => {
  it('returns the token value from a response carrying the cookie', () => {
    const res = new Response(null, {
      headers: { 'set-cookie': 'qa_refresh=abc123; Path=/v1/auth; HttpOnly' },
    });
    expect(readRefreshFromSetCookie(res)).toBe('abc123');
  });

  it('returns null from a response that does not carry the cookie', () => {
    const res = new Response(null, {
      headers: { 'set-cookie': 'qa_session=xyz; Path=/' },
    });
    expect(readRefreshFromSetCookie(res)).toBeNull();
  });
});

describe('forwardRefreshCookie', () => {
  it('does nothing when the API set no cookie', () => {
    const to = new Response(null);
    forwardRefreshCookie(new Response(null), to);
    expect(to.headers.get('set-cookie')).toBeNull();
  });

  it('leaves a non-qa_refresh cookie untouched', () => {
    const from = new Response(null, {
      headers: { 'set-cookie': 'some_other=val; Path=/; HttpOnly' },
    });
    const to = new Response(null);
    forwardRefreshCookie(from, to);
    const all = to.headers.getSetCookie();
    expect(all.some((c) => c === 'some_other=val; Path=/; HttpOnly')).toBe(true);
  });

  it('appends rather than replaces: a response with qa_session ends up with both cookies', () => {
    const from = new Response(null, {
      headers: { 'set-cookie': 'qa_refresh=abc; Path=/v1/auth; HttpOnly; Secure; SameSite=Lax' },
    });
    const to = new Response(null, { headers: { 'set-cookie': 'qa_session=xyz; Path=/' } });
    forwardRefreshCookie(from, to);
    const all = to.headers.getSetCookie();
    expect(all.some((c) => c.startsWith(`${REFRESH_COOKIE}=`))).toBe(true);
    expect(all.some((c) => c.startsWith('qa_session='))).toBe(true);
  });

  it('re-scopes the refresh cookie path when forwarding', () => {
    const from = new Response(null, {
      headers: { 'set-cookie': 'qa_refresh=abc; Path=/v1/auth; HttpOnly' },
    });
    const to = new Response(null);
    forwardRefreshCookie(from, to);
    const all = to.headers.getSetCookie();
    const refreshCookie = all.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
    expect(refreshCookie).toContain(`Path=${REFRESH_COOKIE_PATH}`);
  });
});
