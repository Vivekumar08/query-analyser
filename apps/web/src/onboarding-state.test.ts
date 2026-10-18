// apps/web/src/onboarding-state.test.ts
import { describe, it, expect } from 'vitest';
import { resolveOnboardingStart } from './onboarding-state';

describe('resolveOnboardingStart', () => {
  it('unverified starts at verify', () =>
    expect(resolveOnboardingStart({ emailVerified: false, orgs: [{ slug: 'a' }] })).toEqual({ step: 'verify' }));
  it('no org starts at org', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [] })).toEqual({ step: 'org' }));
  it('with an org starts at app for the first org', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }, { slug: 'b' }] })).toEqual({ step: 'app', org: 'a' }));
  it('targetOrg (from "+ New app") is honoured when the user belongs to it', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }, { slug: 'b' }], targetOrg: 'b' })).toEqual({ step: 'app', org: 'b' }));
  it('targetOrg the user does not belong to is ignored', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }], targetOrg: 'zzz' })).toEqual({ step: 'app', org: 'a' }));
  it('returning user with an unconnected app starts at install for it, without a key', () => {
    const r = resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }], apps: [
      { id: '1', name: 'one', lastSeenAt: '2026-01-01' }, { id: '2', name: 'two', lastSeenAt: null },
    ] });
    expect(r).toEqual({ step: 'install', org: 'a', app: { id: '2', name: 'two' } });
    expect(r).not.toHaveProperty('key');
  });
  it('all apps connected means done (go to dashboard)', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }], apps: [{ id: '1', name: 'one', lastSeenAt: 'x' }] })).toBe('done'));
  it('no apps starts at app', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }], apps: [] })).toEqual({ step: 'app', org: 'a' }));
  it('targetOrg ("+ New app") wins over an unconnected app', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }, { slug: 'b' }], targetOrg: 'b', apps: [{ id: '2', name: 'two', lastSeenAt: null }] })).toEqual({ step: 'app', org: 'b' }));
  it('never carries a key', () => {
    for (const orgs of [[], [{ slug: 'a' }]]) {
      expect(resolveOnboardingStart({ emailVerified: true, orgs, apps: [{ id: '2', name: 'two', lastSeenAt: null }] })).not.toHaveProperty('key');
    }
  });
});
