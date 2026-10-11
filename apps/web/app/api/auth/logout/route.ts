import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/src/session';
import { apiOrigin } from '@/src/api';
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from '@/src/refresh-cookie';

export async function POST(): Promise<Response> {
  const jar = await cookies();
  // Scoped to /api/auth by the login/signup handlers, so it arrives here.
  const refresh = jar.get(REFRESH_COOKIE)?.value;

  // Tell the API to revoke the refresh family. Server-to-server, so we pass
  // the cookie as an explicit header rather than relying on Path matching.
  // Best effort: if it fails we still clear our own cookies, because a user
  // who clicked "log out" must end up logged out of this browser regardless.
  await fetch(`${apiOrigin()}/v1/auth/logout`, {
    method: 'POST',
    headers: refresh ? { cookie: `${REFRESH_COOKIE}=${refresh}` } : {},
    cache: 'no-store',
  }).catch(() => null);

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  // Must delete at the same path it was set at (/api/auth) — deleting at the
  // default path ('/') would leave the real cookie in place and the user
  // still refreshable.
  res.cookies.delete({ name: REFRESH_COOKIE, path: REFRESH_COOKIE_PATH });
  return res;
}
