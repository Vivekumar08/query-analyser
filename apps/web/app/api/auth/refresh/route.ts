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

/** Only same-origin absolute paths, so `?next=` cannot be an open redirect. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get('next'));

  // EXACTLY ONCE. Arriving here with r=1 means a refresh already happened for
  // this navigation and the retry still failed, so stop rather than bounce
  // forever between the dashboard and this route.
  if (url.searchParams.get('r') === '1') {
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

  // `clone()` because the single-flight guard hands the same Response object
  // to every concurrent caller, and a body can only be read once.
  const { accessToken } = (await upstream.clone().json()) as { accessToken: string };

  const retry = new URL(next, url.origin);
  retry.searchParams.set('r', '1');
  const res = NextResponse.redirect(retry);
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'));
  // Forwards the API's rotated qa_refresh cookie (re-scoped to /api/auth) so
  // the NEXT refresh presents a live token instead of the one just consumed.
  forwardRefreshCookie(upstream, res);
  return res;
}
