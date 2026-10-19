// apps/web/src/landing.test.ts
import { describe, it, expect } from 'vitest';
import { resolveLanding, appPath, readLastApp, orgPath, resolveOrgLanding } from './landing';

const orgs = [
  { slug: 'acme', apps: [{ id: 'a1' }, { id: 'a2' }] },
  { slug: 'beta', apps: [{ id: 'b1' }] },
];

describe('resolveLanding', () => {
  it('unverified email goes to onboarding', () =>
    expect(resolveLanding({ emailVerified: false, orgs, lastApp: 'acme/a1' })).toEqual({ kind: 'onboarding' }));
  it('no orgs goes to onboarding', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [], lastApp: undefined })).toEqual({ kind: 'onboarding' }));
  it('org without apps lands on that org', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'acme', apps: [] }], lastApp: undefined })).toEqual({ kind: 'org', org: 'acme' }));
  it('with no apps anywhere, lands on the first org (its empty state), not onboarding', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'm1', apps: [] }, { slug: 'm2', apps: [] }], lastApp: undefined }))
      .toEqual({ kind: 'org', org: 'm1' }));
  it('any app beats an empty org', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'empty', apps: [] }, ...orgs], lastApp: undefined }))
      .toEqual({ kind: 'app', org: 'acme', app: 'a1' }));
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

describe('orgPath', () => { it('encodes', () => expect(orgPath('ac me')).toBe('/dashboard/ac%20me')); });

describe('resolveOrgLanding', () => {
  it('last app in this org wins', () => expect(resolveOrgLanding({ org: 'acme', apps: [{ id: 'a1' }, { id: 'a2' }], lastApp: 'acme/a2' })).toBe('/dashboard/acme/a2/queries'));
  it('last app in another org is ignored', () => expect(resolveOrgLanding({ org: 'acme', apps: [{ id: 'a1' }], lastApp: 'beta/a1' })).toBe('/dashboard/acme/a1/queries'));
  it('a stale last app falls back to the first', () => expect(resolveOrgLanding({ org: 'acme', apps: [{ id: 'a1' }], lastApp: 'acme/zz' })).toBe('/dashboard/acme/a1/queries'));
  it('no apps → null', () => expect(resolveOrgLanding({ org: 'acme', apps: [], lastApp: undefined })).toBeNull());
});

describe('readLastApp', () => {
  it('decodes the URI-encoded cookie value', () => {
    expect(readLastApp('acme%2Fa1')).toBe('acme/a1');
    expect(resolveLanding({
      emailVerified: true,
      orgs: [{ slug: 'acme', apps: [{ id: 'a1' }] }],
      lastApp: readLastApp('acme%2Fa1'),
    })).toEqual({ kind: 'app', org: 'acme', app: 'a1' });
  });
  it('returns undefined for missing or malformed values', () => {
    expect(readLastApp(undefined)).toBeUndefined();
    expect(readLastApp('%E0%A4%A')).toBeUndefined();
  });
});
