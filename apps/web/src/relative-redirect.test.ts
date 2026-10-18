import { describe, it, expect } from 'vitest';
import { loginPath, relativeRedirect } from './relative-redirect';

describe('relativeRedirect', () => {
  it('emits a 307 whose Location is exactly the given path', () => {
    const res = relativeRedirect('/dashboard?tab=slow');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/dashboard?tab=slow');
  });

  it.each(['//evil.com', 'https://evil.com', '/\\evil.com', 'dashboard'])(
    'fails closed to / for a value safeNext could never produce (%s)',
    (raw) => {
      expect(relativeRedirect(raw).headers.get('location')).toBe('/');
    },
  );
});

describe('loginPath', () => {
  it('omits next for the default /', () => {
    expect(loginPath('/')).toBe('/login');
  });

  it('encodes next, query string included', () => {
    expect(loginPath('/dashboard/q?tab=slow&page=2')).toBe('/login?next=%2Fdashboard%2Fq%3Ftab%3Dslow%26page%3D2');
  });
});
