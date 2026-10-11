/** The web app's own cookie. Distinct from the API's `qa_refresh`. */
export const SESSION_COOKIE = 'qa_session';

/**
 * Matches the API's access-token lifetime (`expiresIn: '15m'`).
 *
 * A cookie that outlives its token is worse than one that expires with it:
 * every request in the gap 401s and triggers a refresh redirect that a
 * correctly-sized cookie would have made unnecessary.
 */
export const SESSION_MAX_AGE_SECONDS = 900;

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * `httpOnly` is the spec's core auth requirement: the access token must never
 * reach client JavaScript, so an XSS on any page cannot read it.
 *
 * `secure` is conditional only so the cookie works over http://localhost in
 * development; it is always true in production.
 */
export function sessionCookieOptions(isProd: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
