import type { NextConfig } from 'next';

/**
 * The spec's CSP (Hardening). Everything the app loads is same-origin:
 * next/font self-hosts the Google fonts, there are no external images,
 * analytics or workers, and every browser fetch goes to our own BFF.
 * Web Crypto and the clipboard API are not governed by CSP.
 *
 * `next dev` (React refresh, dev overlay call stacks) needs eval, so
 * `'unsafe-eval'` is added to script-src outside production only.
 * A nonce-based script-src without `'unsafe-inline'` is a recorded follow-up.
 */
function contentSecurityPolicy(isProd: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

const config: NextConfig = {
  // The Dockerfile copies `.next/standalone`, which only exists with this set.
  // Without it the image has no server to run and the container exits.
  output: 'standalone',

  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    const headers = [
      { key: 'Content-Security-Policy', value: contentSecurityPolicy(isProd) },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];
    // Production already assumes HTTPS: session and refresh cookies are
    // `Secure` there. Browsers ignore HSTS on plain-http responses, so a
    // local `next start` over http is unaffected. No includeSubDomains or
    // preload: those are irreversible decisions for the domain owner.
    if (isProd) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000' });
    return [{ source: '/:path*', headers }];
  },
};

export default config;
