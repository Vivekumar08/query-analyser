// apps/web/src/onboarding-state.test.ts
import { describe, it, expect } from 'vitest';
import { resolveOnboardingStart } from './onboarding-state';

describe('resolveOnboardingStart', () => {
  it('unverified starts at verify', () =>
    expect(resolveOnboardingStart({ emailVerified: false, orgs: [{ slug: 'a', role: 'OWNER' }] })).toEqual({ step: 'verify' }));
  it('no org starts at org', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [] })).toEqual({ step: 'org' }));
  it('with an org starts at app for the first org', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }, { slug: 'b', role: 'OWNER' }] })).toEqual({ step: 'app', org: 'a' }));
  it('targetOrg (from "+ New app") is honoured when the user belongs to it', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }, { slug: 'b', role: 'OWNER' }], targetOrg: 'b' })).toEqual({ step: 'app', org: 'b' }));
  it('targetOrg the user does not belong to is ignored', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }], targetOrg: 'zzz' })).toEqual({ step: 'app', org: 'a' }));
  it('returning user with an unconnected app starts at install for it, without a key', () => {
    const r = resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }], apps: [
      { id: '1', name: 'one', lastSeenAt: '2026-01-01' }, { id: '2', name: 'two', lastSeenAt: null },
    ] });
    expect(r).toEqual({ step: 'install', org: 'a', app: { id: '2', name: 'two' } });
    expect(r).not.toHaveProperty('key');
  });
  it('all apps connected means done (go to dashboard)', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }], apps: [{ id: '1', name: 'one', lastSeenAt: 'x' }] })).toBe('done'));
  it('no apps starts at app', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }], apps: [] })).toEqual({ step: 'app', org: 'a' }));
  it('targetOrg ("+ New app") wins over an unconnected app', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }, { slug: 'b', role: 'OWNER' }], targetOrg: 'b', apps: [{ id: '2', name: 'two', lastSeenAt: null }] })).toEqual({ step: 'app', org: 'b' }));
  it('never carries a key', () => {
    for (const orgs of [[], [{ slug: 'a', role: 'OWNER' as const }]]) {
      expect(resolveOnboardingStart({ emailVerified: true, orgs, apps: [{ id: '2', name: 'two', lastSeenAt: null }] })).not.toHaveProperty('key');
    }
  });
  it('new=org starts at org even with orgs', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }], newOrg: true })).toEqual({ step: 'org' }));
  it('new=org still verifies first', () =>
    expect(resolveOnboardingStart({ emailVerified: false, orgs: [], newOrg: true })).toEqual({ step: 'verify' }));
  it.each(['MEMBER', 'VIEWER'] as const)('a %s in the first org is done, never app/install', (role) => {
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role }] })).toBe('done');
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role }], apps: [{ id: '2', name: 'two', lastSeenAt: null }] })).toBe('done');
  });
  it('a MEMBER targetOrg is done', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }, { slug: 'b', role: 'MEMBER' }], targetOrg: 'b' })).toBe('done'));
  it('an ADMIN targetOrg starts at app', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'b', role: 'ADMIN' }], targetOrg: 'b' })).toEqual({ step: 'app', org: 'b' }));
});
