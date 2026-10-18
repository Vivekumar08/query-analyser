import { describe, it, expect } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { config, proxy } from '../proxy.js';

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
    // /api/auth/refresh in particular: the proxy redirects there, so if the
    // matcher caught it a session-less request would bounce forever.
    for (const url of ['/_next/static/chunk.js', '/api/auth/login', '/api/auth/refresh', '/favicon.ico']) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    }
  });
});

describe('proxy redirect', () => {
  it('lets a request with a session cookie through', () => {
    const req = new NextRequest('https://web.example.com/dashboard', { headers: { cookie: 'qa_session=tok' } });
    const res = proxy(req);
    expect(res.headers.get('location')).toBeNull();
  });

  it('sends a request without qa_session to the refresh handler, not /login (B5/B14)', () => {
    // At the 15-minute expiry the browser sends NO qa_session, but the
    // refresh token may still be good. Only the refresh handler can see it;
    // redirecting straight to /login here logged valid users out.
    const res = proxy(new NextRequest('https://web.example.com/dashboard'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://web.example.com/api/auth/refresh?next=%2Fdashboard');
  });

  it('preserves the query string in next, encoded', () => {
    const res = proxy(new NextRequest('https://web.example.com/dashboard/q?tab=slow&page=2'));
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/api/auth/refresh');
    expect(location.search).toBe('?next=%2Fdashboard%2Fq%3Ftab%3Dslow%26page%3D2');
    expect(location.searchParams.get('next')).toBe('/dashboard/q?tab=slow&page=2');
  });
});
