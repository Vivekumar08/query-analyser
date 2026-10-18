import { describe, it, expect } from 'vitest';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, sessionCookieOptions } from './session';

describe('session cookie', () => {
  it('is named distinctly from the API\'s refresh cookie', () => {
    // The API sets `qa_refresh` on path /v1/auth. If the web app reused that
    // name it would overwrite the refresh token with an access token and
    // silently destroy every session on the next refresh.
    expect(SESSION_COOKIE).toBe('qa_session');
    expect(SESSION_COOKIE).not.toBe('qa_refresh');
  });

  it('is httpOnly, so the access token never reaches client JavaScript', () => {
    // This is the spec's core auth requirement. If httpOnly is ever dropped,
    // any XSS on the page can read the token.
    expect(sessionCookieOptions(true).httpOnly).toBe(true);
    expect(sessionCookieOptions(false).httpOnly).toBe(true);
  });

  it('is Secure in production and not in development', () => {
    // Secure in dev would make the cookie unusable over http://localhost.
    expect(sessionCookieOptions(true).secure).toBe(true);
    expect(sessionCookieOptions(false).secure).toBe(false);
  });

  it('is lax and path-wide, so it is sent on same-origin navigations', () => {
    expect(sessionCookieOptions(true).sameSite).toBe('lax');
    expect(sessionCookieOptions(true).path).toBe('/');
  });

  it('expires no later than the access token it carries', () => {
    // The API signs access tokens with expiresIn '15m'. A cookie outliving
    // its token means every request inside the gap 401s and triggers a
    // refresh redirect that did not need to happen.
    expect(SESSION_MAX_AGE_SECONDS).toBe(900);
    expect(sessionCookieOptions(true).maxAge).toBe(900);
  });
});
