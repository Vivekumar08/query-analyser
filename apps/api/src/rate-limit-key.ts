import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Headers the web app's auth route handlers attach to every upstream call (Ruling B20). */
export const CLIENT_IP_HEADER = 'x-qa-client-ip';
export const PROXY_SECRET_HEADER = 'x-qa-proxy-secret';

interface KeyableRequest {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Builds the rate limiter's bucket key function.
 *
 * Every browser login/signup reaches this API from the web server's address,
 * not the browser's, so keying on `req.ip` alone collapses the per-IP auth
 * limits into ONE global bucket: ~21 bad logins a minute from anyone would
 * lock every user out. The web app therefore forwards the browser's IP in
 * `x-qa-client-ip`, together with a shared secret in `x-qa-proxy-secret`.
 *
 * The header is believed ONLY when the secret matches `WEB_PROXY_SECRET`
 * (constant-time compare, length-checked first) and the value is a literal IP
 * address. Otherwise — no secret configured, missing or wrong secret, junk
 * value — the key is `req.ip`, exactly as before. That keeps the rule from
 * the original comment intact: the key is never derived from content an
 * arbitrary client controls, because an attacker without the secret cannot
 * choose their bucket.
 */
export function makeRateLimitKey(proxySecret: string | undefined): (req: KeyableRequest) => string {
  if (!proxySecret) return (req) => req.ip;
  const expected = Buffer.from(proxySecret, 'utf8');

  return (req) => {
    const presented = single(req.headers[PROXY_SECRET_HEADER]);
    if (presented === undefined) return req.ip;
    const got = Buffer.from(presented, 'utf8');
    // timingSafeEqual throws on unequal lengths; the length itself is not
    // the secret, so checking it first leaks nothing useful.
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return req.ip;

    const clientIp = single(req.headers[CLIENT_IP_HEADER])?.trim();
    if (!clientIp || isIP(clientIp) === 0) return req.ip;
    return clientIp;
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}
