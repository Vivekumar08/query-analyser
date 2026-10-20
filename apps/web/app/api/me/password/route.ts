import { NextResponse } from 'next/server';
import { apiOrigin } from '@/src/api';
import { gate, jsonError, NO_STORE } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import { upstreamAuthHeaders } from '@/src/upstream-headers';
import { SESSION_COOKIE, sessionCookieOptions } from '@/src/session';
import { forwardRefreshCookie } from '@/src/refresh-cookie';

const PASSWORD_MAX = 200;
const NEW_PASSWORD_MIN = 12;

function failure(status: number): Response {
  switch (status) {
    // Validation, or the new password equals the current one.
    case 400: return jsonError('Choose a new password of 12–200 characters that differs from your current one.', 400);
    case 401: return jsonError('unauthorized', 401);
    case 403: return jsonError('Your current password is incorrect.', 403);
    // Another change to this password committed first; this one did nothing.
    case 409: return jsonError('Your password was just changed elsewhere. Sign in again.', 409);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(status, 'generic'), 502);
  }
}

const isPassword = (v: unknown, min: number): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= PASSWORD_MAX;

/**
 * Changes the signed-in user's password, then stores the fresh session the
 * API issues exactly as login does (see `handleCredentialsAuth`).
 *
 * A raw fetch, not `authedFetch`: that helper drops the upstream Set-Cookie
 * (the new `qa_refresh`) and doesn't forward the browser's IP, which the
 * API's 10/min limit needs to stay per user rather than per web server.
 */
export async function POST(request: Request): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;

  const raw = (await request.json().catch(() => null)) as { currentPassword?: unknown; newPassword?: unknown } | null;
  const currentPassword = raw && typeof raw === 'object' ? raw.currentPassword : undefined;
  const newPassword = raw && typeof raw === 'object' ? raw.newPassword : undefined;
  if (!isPassword(currentPassword, 1) || !isPassword(newPassword, NEW_PASSWORD_MIN)) return failure(400);

  let upstream: Response;
  let accessToken: unknown;
  try {
    upstream = await fetch(`${apiOrigin()}/v1/me/password`, {
      method: 'POST',
      headers: upstreamAuthHeaders(request, {
        'content-type': 'application/json',
        authorization: `Bearer ${g.session.accessToken}`,
      }),
      body: JSON.stringify({ currentPassword, newPassword }),
      cache: 'no-store',
    });
    if (!upstream.ok) return failure(upstream.status);
    accessToken = ((await upstream.json()) as { accessToken?: unknown } | null)?.accessToken;
  } catch {
    return failure(502);
  }
  if (typeof accessToken !== 'string' || accessToken === '') return failure(502);

  // The token goes only into the httpOnly cookie, never the JSON body.
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'));
  // After our own cookie: appends the API's qa_refresh, rescoped from
  // Path=/v1/auth to Path=/api/auth.
  forwardRefreshCookie(upstream, res);
  return res;
}
