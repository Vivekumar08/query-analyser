import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, sessionCookieOptions } from '@/src/session';
import { apiOrigin } from '@/src/api';
import {
  REFRESH_COOKIE,
  REFRESH_ATTEMPT_COOKIE,
  forwardRefreshCookie,
  refreshAttemptCookieOptions,
} from '@/src/refresh-cookie';
import { singleFlight } from '@/src/single-flight';
import { safeNext } from '@/src/safe-next';

/**
 * Module-scope so concurrent requests share it. This is a route handler, not
 * proxy.ts — Next's docs say proxy must not rely on shared modules or
 * globals, which is exactly why the refresh lives here.
 */
const run = singleFlight<Response>();

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const isProd = process.env.NODE_ENV === 'production';
  const toLogin = () => NextResponse.redirect(new URL('/login', url.origin));

  const jar = await cookies();

  // EXACTLY ONCE (Ruling B13). A previous hop rotated the pair and set this
  // marker; arriving with it means the retried page STILL had no usable
  // session. Rotating again would loop, burning a real refresh token per
  // bounce, so stop — and clear the marker so the next genuine login starts
  // clean. A cookie, not a URL param: it does not depend on callers passing
  // their query string through, and it cannot stick in history or bookmarks.
  if (jar.get(REFRESH_ATTEMPT_COOKIE)) {
    const res = toLogin();
    res.cookies.set(REFRESH_ATTEMPT_COOKIE, '', refreshAttemptCookieOptions(isProd, 0));
    return res;
  }

  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return toLogin();

  // Keyed on the refresh token value: concurrent renders carrying the SAME
  // token must collapse into one rotation, or the API's family-revocation
  // sees the second call as a replay and logs the user out of everything.
  const upstream = await run(refresh, () =>
    fetch(`${apiOrigin()}/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `${REFRESH_COOKIE}=${refresh}` },
      cache: 'no-store',
    }),
  );

  if (!upstream.ok) return toLogin();

  // Guarded: a truncated/non-JSON body, or a 200 missing `accessToken`, must
  // not throw out of the handler (a 500 mid-navigation with no /login
  // fallback) or set `qa_session` to `undefined` (which guarantees the next
  // navigation loops straight back here).
  let accessToken: string;
  try {
    // `clone()` because the single-flight guard hands the same Response
    // object to every concurrent caller, and a body can only be read once.
    const body = (await upstream.clone().json()) as { accessToken?: unknown };
    if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
      return toLogin();
    }
    accessToken = body.accessToken;
  } catch {
    return toLogin();
  }

  // safeNext guarantees a single-slash, same-origin path (no leading `//`, no backslash),
  // so this URL object resolves on our origin. Redirect with the URL object
  // itself; never hand the path to anything that re-parses it as a string.
  // The origin re-check is belt and braces: if it ever fails, safeNext broke.
  const target = new URL(safeNext(url.searchParams.get('next'), url.origin), url.origin);
  if (target.origin !== url.origin) return toLogin();

  const res = NextResponse.redirect(target);
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(isProd));
  res.cookies.set(REFRESH_ATTEMPT_COOKIE, '1', refreshAttemptCookieOptions(isProd));
  // Forwards the API's rotated qa_refresh cookie (re-scoped to /api/auth) so
  // the NEXT refresh presents a live token instead of the one just consumed.
  forwardRefreshCookie(upstream, res);
  return res;
}
