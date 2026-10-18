import { NextResponse } from 'next/server';

/**
 * CSRF guard for the auth POST handlers (Ruling B19). Returns a 403 to send
 * back, or null when the request may proceed.
 *
 * Why the web layer needs this when the API does not: the API only parses JSON
 * bodies, so a cross-site HTML form (`enctype="text/plain"`) can never reach
 * it without a CORS preflight. These handlers forward the raw body upstream as
 * JSON, which turned that same form into a valid login — login CSRF, where the
 * victim ends up signed in to the attacker's account and installs the
 * attacker's ingest key. Both checks are required:
 *
 * - `Content-Type: application/json`: a cross-site form can only send
 *   urlencoded, multipart or text/plain; JSON from another origin needs a
 *   preflight, which this app never answers.
 * - `Origin` equals the public web origin: browsers always send Origin on a
 *   POST, so a missing Origin is not a browser on our page. Non-browser
 *   clients should call the API directly.
 *
 * The public origin is `WEB_ORIGIN`. Not request.url: in the standalone server
 * that is the bind address (see relative-redirect.ts). When `WEB_ORIGIN` is
 * unset (local dev), the Origin's host must equal the Host header instead.
 */
export function rejectCrossSiteAuthPost(request: Request): Response | null {
  const contentType = request.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return forbidden();

  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return forbidden();

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return forbidden();
  }

  const configured = process.env.WEB_ORIGIN;
  if (configured) {
    let expected: string;
    try {
      expected = new URL(configured).origin;
    } catch {
      // A malformed WEB_ORIGIN must fail closed, not fall through to the
      // weaker Host comparison.
      return forbidden();
    }
    return originUrl.origin === expected ? null : forbidden();
  }

  const host = request.headers.get('host');
  if (!host) return forbidden();
  return originUrl.host === host.toLowerCase() ? null : forbidden();
}

function forbidden(): Response {
  return NextResponse.json({ error: 'forbidden' }, { status: 403 });
}
