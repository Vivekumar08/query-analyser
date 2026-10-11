import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from './src/session.js';

/**
 * Redirect UX only. This is NOT the security gate.
 *
 * Next 16's docs warn that a matcher change, or moving a Server Function to a
 * different route, silently removes proxy coverage — and that auth must be
 * verified in the data layer regardless. `requireSession()` in src/auth.ts is
 * the real gate; this exists so an anonymous visitor gets a clean redirect
 * instead of a render that redirects.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = new URL('/login', request.url);
  login.searchParams.set('next', request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    // Everything except the public pages, the auth route handlers, Next's own
    // assets and metadata files. The negative lookahead is the documented
    // pattern; without it the proxy runs on CSS and JS too and blocks them.
    '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|login|signup|verify|reset-password|$).*)',
  ],
};
