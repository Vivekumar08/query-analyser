import { NextResponse } from 'next/server';

/**
 * A 307 whose `Location` is a bare path, never an absolute URL (Ruling B18).
 *
 * Route handlers must not build redirect targets from `request.url`. In Next's
 * standalone server that URL is `${proto}://${HOSTNAME}:${PORT}${path}` — the
 * container's bind address, not the public host the browser used — so an
 * absolute Location sends the visitor to `https://0.0.0.0:3000/...`. Next
 * relativises same-host redirects coming out of proxy.ts, but does nothing for
 * route handlers. RFC 9110 allows a relative Location, and the browser resolves
 * it against the URL it actually requested.
 *
 * `path` MUST already be validated: safeNext output, or a constant built from
 * it. safeNext guarantees a single leading slash, so the value can never be
 * read as protocol-relative (`//evil.com`).
 *
 * `NextResponse.redirect` cannot be used: it rejects anything that is not an
 * absolute URL.
 */
export function relativeRedirect(path: string): NextResponse {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    // Belt and braces: callers pass safeNext output, which can never fail
    // this. If it ever does, safeNext broke — fail closed to the home page.
    path = '/';
  }
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

/** `/login`, carrying a validated `next` (Ruling B15); omitted when it is the default `/`. */
export function loginPath(next: string): string {
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}
