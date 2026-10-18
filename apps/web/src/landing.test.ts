// apps/web/src/landing.test.ts
import { describe, it, expect } from 'vitest';
import { resolveLanding, appPath } from './landing';

const orgs = [
  { slug: 'acme', apps: [{ id: 'a1' }, { id: 'a2' }] },
  { slug: 'beta', apps: [{ id: 'b1' }] },
];

describe('resolveLanding', () => {
  it('unverified email goes to onboarding', () =>
    expect(resolveLanding({ emailVerified: false, orgs, lastApp: 'acme/a1' })).toEqual({ kind: 'onboarding' }));
  it('no orgs goes to onboarding', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [], lastApp: undefined })).toEqual({ kind: 'onboarding' }));
  it('org without apps goes to onboarding', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'acme', apps: [] }], lastApp: undefined })).toEqual({ kind: 'onboarding' }));
  it('valid cookie wins', () =>
    expect(resolveLanding({ emailVerified: true, orgs, lastApp: 'beta/b1' })).toEqual({ kind: 'app', org: 'beta', app: 'b1' }));
  it('stale cookie (app gone) falls back to first app', () =>
    expect(resolveLanding({ emailVerified: true, orgs, lastApp: 'acme/zz' })).toEqual({ kind: 'app', org: 'acme', app: 'a1' }));
  it('cookie for an org no longer a member of falls back', () =>
    expect(resolveLanding({ emailVerified: true, orgs, lastApp: 'gone/b1' })).toEqual({ kind: 'app', org: 'acme', app: 'a1' }));
  it('first org with apps is chosen when the first org is empty', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'empty', apps: [] }, ...orgs], lastApp: undefined }))
      .toEqual({ kind: 'app', org: 'acme', app: 'a1' }));
});

describe('appPath', () => {
  it('builds the queries path with encoded segments', () =>
    expect(appPath('ac me', 'a/1')).toBe('/dashboard/ac%20me/a%2F1/queries'));
});
