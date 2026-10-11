import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/src/session';
import { apiOrigin } from '@/src/api';
import { forwardRefreshCookie } from '@/src/refresh-cookie';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  const upstream = await fetch(`${apiOrigin()}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    // Pass the API's status and body through unchanged — the login form
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
