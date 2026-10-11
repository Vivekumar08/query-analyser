import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, sessionCookieOptions } from '@/src/session';
import { apiOrigin } from '@/src/api';
import { REFRESH_COOKIE, forwardRefreshCookie } from '@/src/refresh-cookie';
import { singleFlight } from '@/src/single-flight';

/**
 * Module-scope so concurrent requests share it. This is a route handler, not
 * proxy.ts — Next's docs say proxy must not rely on shared modules or
 * globals, which is exactly why the refresh lives here.
 */
const run = singleFlight<Response>();

/**
 * Only same-origin paths, resolved and compared by origin rather than by
 * string prefix.
 *
 * A prefix check (`startsWith('/') && !startsWith('//')`) looks sufficient
 * but is not: `/\evil.com` passes it, yet WHATWG URL parsing normalises the
 * leading backslash to a slash for special schemes, so
 * `new URL('/\\evil.com', 'https://site')` resolves to `https://evil.com/`.
 * Resolving against the real origin and comparing origins closes that off.
 */
function safeNext(raw: string | null, origin: string): string {
  if (!raw) return '/';
  let resolved: URL;
  try {
    resolved = new URL(raw, origin);
  } catch {
    return '/';
  }
  if (resolved.origin !== origin) return '/';
  return resolved.pathname + resolved.search;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get('next'), url.origin);

  // EXACTLY ONCE. The marker is read out of `next`, not out of this request's
  // own query string: a successful refresh writes `r=1` onto the PAGE's
  // retry URL (below), which becomes `next` the *next* time a page without a
  // session redirects back here. This request's own `?r=` is never set by
  // any caller, so checking it here was dead code — the flow could rotate a
  // real refresh token on every iteration of an unbounded loop.
  if (new URL(next, url.origin).searchParams.get('r') === '1') {
    return NextResponse.redirect(new URL('/login', url.origin));
  }

  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return NextResponse.redirect(new URL('/login', url.origin));

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

  if (!upstream.ok) return NextResponse.redirect(new URL('/login', url.origin));

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
      return NextResponse.redirect(new URL('/login', url.origin));
    }
    accessToken = body.accessToken;
  } catch {
    return NextResponse.redirect(new URL('/login', url.origin));
  }

  const retry = new URL(next, url.origin);
  retry.searchParams.set('r', '1');
  const res = NextResponse.redirect(retry);
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'));
  // Forwards the API's rotated qa_refresh cookie (re-scoped to /api/auth) so
  // the NEXT refresh presents a live token instead of the one just consumed.
  forwardRefreshCookie(upstream, res);
  return res;
}
