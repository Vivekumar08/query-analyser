import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from './src/session';

/**
 * Redirect UX only. This is NOT the security gate.
 *
 * Next 16's docs warn that a matcher change, or moving a Server Function to a
 * different route, silently removes proxy coverage — and that auth must be
 * verified in the data layer regardless. `requireSession()` in src/auth.ts is
 * the real gate; this exists so a session-less request gets a clean redirect
 * instead of a render that redirects.
 *
 * It redirects to the refresh handler, NOT to /login (Rulings B5/B14). The
 * session cookie's maxAge equals the access token's lifetime, so at expiry the
 * browser sends no `qa_session` at all — "absent" cannot be read as "logged
 * out". Only `/api/auth/refresh` receives the refresh cookie (Path=/api/auth),
 * so only it can decide: rotate and come back, or send the visitor to /login
 * (no refresh cookie, a failed rotation, or the one-hop marker from B13).
 *
 * `next` carries pathname AND search so the visitor returns to exactly where
 * they were; the handler validates it with safeNext. No loop: the matcher
 * excludes `/api`, so the proxy never runs on the refresh handler itself.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  // Absolute on purpose, and from request.url on purpose (Ruling B18 audit).
  // Proxy is the one place a relative Location cannot be used: Next's proxy
  // adapter re-parses Location with `new URL(value)` and a bare path throws
  // (probed on the standalone build: HTTP 500, `TypeError: Invalid URL`). The
  // same adapter then RELATIVISES any Location whose host equals the
  // request's host, so the browser receives `/api/auth/refresh?next=…` and
  // the bind address never leaves the server. That only holds while this URL
  // is built on request.url's own host — a different base would be emitted
  // verbatim. src/proxy.test.ts pins the same-host invariant.
  const refresh = new URL('/api/auth/refresh', request.url);
  refresh.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(refresh);
}

export const config = {
  matcher: [
    // Everything except the public pages, the auth route handlers, Next's own
    // assets and metadata files. The negative lookahead is the documented
    // pattern; without it the proxy runs on CSS and JS too and blocks them.
    '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|login|signup|verify|reset-password|$).*)',
  ],
};
