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
  if (!res.ok) {
    // Only a 401 means "this token is no good" — the refreshable case, where
    // null correctly sends the caller to the refresh route. A 500, a network
    // error, or anything else means the API is unreachable or broken, which
    // is not fixed by a refresh: treating it as "no session" would send the
    // visitor straight back into the refresh loop on every retry, rotating a
    // real refresh token each time for no reason. Throwing instead lets it
    // surface as a real error rather than being silently reinterpreted as
    // "logged out".
    if (res.status === 401) return null;
    throw new Error(`session check failed with status ${res.status}: ${res.error}`);
  }

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
 * Bounded to ONE refresh per navigation by the refresh handler, not by the
 * caller: on a successful rotation it sets a short-lived HttpOnly marker
 * cookie (`qa_refresh_attempt`, Path=/api/auth, 30s). If the retried page
 * still has no usable session and lands back here, the handler sees the
 * marker, clears it and sends the visitor to `/login` instead of rotating
 * again. Nothing is written into the page URL, so the bound holds whatever
 * `currentPath` a caller passes (with or without its query string), and
 * nothing sticks in history or bookmarks to log a valid user out on reload.
 *
 * `currentPath` is where to return after the refresh. Pass the path the
 * visitor asked for, including its query string if it matters to the page;
 * the handler validates it with `safeNext`, so it is never an open redirect.
 */
export async function requireSession(currentPath: string): Promise<Session> {
  const session = await getSession();
  if (!session) {
    redirect(`/api/auth/refresh?next=${encodeURIComponent(currentPath)}`);
  }
  return session;
}
