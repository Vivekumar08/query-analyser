import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from './session.js';
import { authedFetch } from './api.js';

export interface Session {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    isPlatformAdmin: boolean;
    emailVerifiedAt: string | null;
  };
}

/**
 * Reads the session, or null.
 *
 * This is the real gate, not `proxy.ts`. Next 16's docs are explicit that a
 * matcher change or moving a Server Function to another route can silently
 * remove proxy coverage, and that auth must be checked in the data layer
 * rather than relying on proxy alone.
 */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const accessToken = jar.get(SESSION_COOKIE)?.value;
  if (!accessToken) return null;

  const res = await authedFetch<Session['user']>('/v1/me', accessToken);
  if (!res.ok) return null;

  return { accessToken, user: res.data };
}

/**
 * Same, but sends an anonymous visitor onward — to the refresh route, not
 * straight to `/login`.
 *
 * The session cookie's `maxAge` (900s) equals the access token's lifetime, so
 * at expiry the browser sends NO cookie at all — not an expired one. "Cookie
 * absent" is therefore indistinguishable, from here, between "never logged
 * in" and "token aged out one second ago". Only the refresh handler can tell
 * the difference, because it is the only path the refresh cookie is scoped
 * to: it rotates the pair if the refresh token is still good, or sends the
 * visitor to `/login` itself if there is genuinely no session to recover.
 * Redirecting straight to `/login` from here would log out a valid session
 * every 15 minutes.
 *
 * Takes the current path as a parameter rather than reading `headers()`,
 * because every caller is a page that already knows its own path — there is
 * no need to couple this gate to a request API it does not otherwise need.
 */
export async function requireSession(currentPath: string): Promise<Session> {
  const session = await getSession();
  if (!session) {
    redirect(`/api/auth/refresh?next=${encodeURIComponent(currentPath)}`);
  }
  return session;
}
