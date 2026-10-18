/** Header names agreed with apps/api's rate limiter (apps/api/src/rate-limit-key.ts). */
export const CLIENT_IP_HEADER = 'x-qa-client-ip';
export const PROXY_SECRET_HEADER = 'x-qa-proxy-secret';

/**
 * Headers every upstream /v1/auth/* call carries (Ruling B20).
 *
 * The browser never talks to the API's auth routes; these handlers do, so the
 * API sees the web server's IP on every login and its per-IP limits become
 * one global bucket. Forwarding the browser's IP fixes that — but the API only
 * believes it when it arrives with `WEB_PROXY_SECRET`, so a client calling the
 * API directly cannot pick its own bucket.
 *
 * The browser's IP is the LAST (rightmost) X-Forwarded-For entry: the one
 * appended by the proxy directly in front of the web container. Every entry
 * to its left is whatever the client sent, so taking the first would let a
 * client rotate `X-Forwarded-For: <random>` and get a fresh rate-limit bucket
 * per request.
 *
 * Trust assumption (also in apps/api/README.md and .env.example): EXACTLY ONE
 * trusted proxy hop (EasyPanel's) sits in front of this container and always
 * appends the peer address. With zero hops (the container reachable directly)
 * a client's single spoofed value would be taken as-is; with two or more
 * hops the rightmost entry is the inner proxy, not the browser. With no
 * X-Forwarded-For (or an empty last entry) no client IP is sent and the API
 * keys on the web server's address, as before.
 *
 * `extra` is merged first so callers cannot accidentally drop these two.
 */
export function upstreamAuthHeaders(request: Request, extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);

  const clientIp = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);

  const secret = process.env.WEB_PROXY_SECRET;
  if (secret) headers.set(PROXY_SECRET_HEADER, secret);

  return headers;
}
