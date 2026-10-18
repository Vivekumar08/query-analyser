/**
 * Validates a redirect target as same-origin and returns it as a bare path
 * (pathname + search), or `fallback`.
 *
 * Three checks, because each one alone has a known bypass:
 *
 * 1. Any backslash is rejected outright. WHATWG URL treats `\` as `/` for
 *    special schemes, so `/\evil.com` resolves to https://evil.com/ while
 *    passing every prefix check you would think to write. No legitimate
 *    in-app path contains one.
 * 2. The resolved origin must equal `origin` — catches absolute URLs,
 *    protocol-relative `//evil.com`, and tab/newline-stripping tricks.
 * 3. The RESOLVED pathname must not start with `//`. Dot segments are
 *    collapsed during parsing, so `/.//evil.com`, `/..//evil.com`,
 *    `/%2e%2e//evil.com` all resolve SAME-origin (check 2 passes) with a
 *    pathname of `//evil.com`. The moment that string is parsed again — a
 *    redirect Location, `router.push` — it is protocol-relative and lands on
 *    https://evil.com. An origin comparison alone does not close this.
 *
 * The returned string is therefore always a single-slash absolute path that
 * re-parses against any base to that base's own origin.
 *
 * Shared deliberately: this check previously existed in two places, one of
 * which was hardened against a bypass while the other sat unchanged. Two
 * copies of a security check drift. One cannot.
 */
export function safeNext(raw: string | null | undefined, origin: string, fallback = '/'): string {
  if (!raw) return fallback;
  if (raw.includes('\\')) return fallback;
  let resolved: URL;
  try {
    resolved = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (resolved.origin !== origin) return fallback;
  if (resolved.pathname.startsWith('//')) return fallback;
  return resolved.pathname + resolved.search;
}
