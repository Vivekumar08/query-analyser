import { afterEach, describe, it, expect, vi } from 'vitest';
import config from '@/next.config';

const SPEC_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

async function headersFor(nodeEnv: string): Promise<Record<string, string>> {
  vi.stubEnv('NODE_ENV', nodeEnv);
  const rules = await config.headers!();
  expect(rules).toHaveLength(1);
  expect(rules[0]!.source).toBe('/:path*');
  return Object.fromEntries(rules[0]!.headers.map((h) => [h.key, h.value]));
}

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values.join(' ')];
    }),
  );
}

afterEach(() => vi.unstubAllEnvs());

describe('security headers', () => {
  it('sends the spec CSP verbatim in production', async () => {
    const h = await headersFor('production');
    expect(h['Content-Security-Policy']).toBe(SPEC_CSP);
    const d = directives(h['Content-Security-Policy']!);
    expect(d.get('frame-ancestors')).toBe("'none'");
    expect(d.get('object-src')).toBe("'none'");
    expect(d.get('connect-src')).toBe("'self'");
  });

  it('never allows unsafe-eval in production', async () => {
    const h = await headersFor('production');
    expect(h['Content-Security-Policy']).not.toContain('unsafe-eval');
  });

  it('allows unsafe-eval in script-src only outside production (Next dev / React refresh)', async () => {
    const h = await headersFor('development');
    const d = directives(h['Content-Security-Policy']!);
    expect(d.get('script-src')).toBe("'self' 'unsafe-inline' 'unsafe-eval'");
    for (const [name, value] of d) if (name !== 'script-src') expect(value).not.toContain('unsafe-eval');
  });

  // same-origin, not no-referrer: no-referrer risks Origin: null on same-origin
  // fetches in some engines, which would fail every BFF mutation's CSRF check.
  // same-origin still sends nothing cross-origin.
  it('sends nosniff, a same-origin Referrer-Policy and a locked-down Permissions-Policy', async () => {
    const h = await headersFor('production');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('same-origin');
    expect(h['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('sends HSTS in production only (cookies are Secure there, so HTTPS is already assumed)', async () => {
    expect((await headersFor('production'))['Strict-Transport-Security']).toBe('max-age=31536000');
    expect((await headersFor('development'))['Strict-Transport-Security']).toBeUndefined();
  });

  it('keeps the standalone output the Dockerfile relies on', () => {
    expect(config.output).toBe('standalone');
  });
});
