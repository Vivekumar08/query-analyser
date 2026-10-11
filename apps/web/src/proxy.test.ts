import { describe, it, expect } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from '../proxy.js';

describe('proxy matcher', () => {
  it('runs on dashboard routes', () => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: '/dashboard' })).toBe(true);
  });

  it('does not run on the public pages', () => {
    // If the matcher caught these, an anonymous visitor would be redirected
    // away from the login page they were just sent to — an infinite bounce.
    for (const url of ['/', '/login', '/signup', '/verify', '/reset-password']) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    }
  });

  it('does not run on static assets or the auth route handlers', () => {
    for (const url of ['/_next/static/chunk.js', '/api/auth/login', '/favicon.ico']) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    }
  });
});
