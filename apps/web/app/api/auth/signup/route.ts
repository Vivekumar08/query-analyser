import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/src/session';
import { apiOrigin } from '@/src/api';
import { forwardRefreshCookie } from '@/src/refresh-cookie';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  // The API awaits the verification mail before replying, which measured
  // ~3.2-3.5s live. The form must show a pending state for the whole time.
  const upstream = await fetch(`${apiOrigin()}/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Success status from the API is 201; we always respond 200.
  const { accessToken } = JSON.parse(text) as { accessToken: string };
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'));
  forwardRefreshCookie(upstream, res);
  return res;
}
