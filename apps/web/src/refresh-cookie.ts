export const REFRESH_COOKIE = 'qa_refresh';
/** The path the WEB APP's handlers live under. The API scopes its own copy to /v1/auth. */
export const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * Rewrites the Path of the API's refresh cookie so the web app's own route
 * handlers receive it.
 *
 * The API scopes `qa_refresh` to `Path=/v1/auth` because that is where IT
 * needs it. Cookie Path is a send-time filter, so with that value the browser
 * would never present the cookie to `/api/auth/*` — refresh and logout would
 * both silently see nothing, and every session would end 15 minutes after
 * login with no way to recover. Verified against the live deployment.
 *
 * Every other attribute is preserved exactly as the API set it: HttpOnly,
 * Secure, SameSite and Max-Age are the API's decisions, not ours.
 */
export function rescopeRefreshCookie(setCookieValue: string): string {
  const first = setCookieValue.split(';')[0]?.trim() ?? '';
  // No name=value pair (e.g. empty input) — nothing to rescope; forging a
  // standalone "; Path=..." attribute string would be a malformed cookie.
  if (first.indexOf('=') === -1) return setCookieValue;

  const parts = setCookieValue.split(';').map((p) => p.trim());
  let found = false;
  const rewritten = parts.map((part) => {
    if (/^path=/i.test(part)) {
      found = true;
      return `Path=${REFRESH_COOKIE_PATH}`;
    }
    return part;
  });
  if (!found) {
    rewritten.push(`Path=${REFRESH_COOKIE_PATH}`);
  }
  return rewritten.join('; ');
}

/** Pulls the refresh cookie's value out of an API response's Set-Cookie headers, or null. */
export function readRefreshFromSetCookie(res: Response): string | null {
  for (const cookie of res.headers.getSetCookie()) {
    const first = cookie.split(';')[0]?.trim() ?? '';
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name === REFRESH_COOKIE) return value;
  }
  return null;
}

/**
 * Forwards the API's Set-Cookie headers onto the outgoing response.
 *
 * The browser posts to our route handler, which calls the API server-to-server.
 * The API's `qa_refresh` cookie therefore arrives *here* and would die here
 * unless forwarded — but it must be re-scoped first (see
 * `rescopeRefreshCookie`), or the browser will never present it back to us.
 * Every other cookie is forwarded unchanged.
 *
 * Appends rather than sets, because the handler has usually already put
 * `qa_session` on the response and a `set` would drop it.
 */
export function forwardRefreshCookie(from: Response, to: Response): void {
  for (const cookie of from.headers.getSetCookie()) {
    const first = cookie.split(';')[0]?.trim() ?? '';
    const name = first.slice(0, first.indexOf('='));
    if (name === REFRESH_COOKIE) {
      to.headers.append('set-cookie', rescopeRefreshCookie(cookie));
    } else {
      to.headers.append('set-cookie', cookie);
    }
  }
}
