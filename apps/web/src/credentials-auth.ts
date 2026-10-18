import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from './session';
import { apiOrigin } from './api';
import { forwardRefreshCookie } from './refresh-cookie';
import { upstreamAuthHeaders } from './upstream-headers';

/**
 * The shared body of the login and signup route handlers.
 *
 * They differ only in the upstream path, so they share this: one call site
 * means the refresh-cookie forwarding below is covered by one test for both
 * routes. Duplicating it meant signup's forwarding went untested, and losing
 * it there would have killed every NEW user's session fifteen minutes after
 * they signed up while logins carried on working.
 *
 * Note the API's signup awaits the verification mail and takes ~3.2-3.5s
 * measured live, so no timeout may be imposed here.
 */
export async function handleCredentialsAuth(
  upstreamPath: '/v1/auth/login' | '/v1/auth/signup',
  request: Request,
): Promise<Response> {
  const upstream = await fetch(`${apiOrigin()}${upstreamPath}`, {
    method: 'POST',
    // Carries the browser's IP + proxy secret so the API's per-IP limits
    // apply per browser, not to this server as a whole (Ruling B20).
    headers: upstreamAuthHeaders(request, { 'content-type': 'application/json' }),
    body: await request.text(),
    cache: 'no-store',
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    // Pass the API's status and body through unchanged — the form
    // distinguishes 401 (bad credentials) from 400 (malformed).
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { accessToken } = JSON.parse(text) as { accessToken: string };
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'));
  // Must come after our own cookie: this appends the API's qa_refresh,
  // re-scoped from Path=/v1/auth to Path=/api/auth so the browser will
  // actually present it to our own handlers.
  forwardRefreshCookie(upstream, res);
  return res;
}
