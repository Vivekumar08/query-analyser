/**
 * Validates a redirect target as same-origin.
 *
 * Resolves and compares origins rather than prefix-matching, because
 * `/\evil.com` passes every prefix check you would think to write and WHATWG
 * URL normalises the backslash, resolving it to https://evil.com/.
 *
 * Shared deliberately: this check previously existed in two places, one of
 * which was hardened against that bypass while the other sat unchanged. Two
 * copies of a security check drift. One cannot.
 */
export function safeNext(raw: string | null | undefined, origin: string, fallback = '/'): string {
  if (!raw) return fallback;
  let resolved: URL;
  try {
    resolved = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (resolved.origin !== origin) return fallback;
  return resolved.pathname + resolved.search;
}
