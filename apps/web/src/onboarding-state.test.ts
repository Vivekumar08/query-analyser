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
  it('never starts at install — the key step is only reachable with a key in memory', () => {
    for (const orgs of [[], [{ slug: 'a' }]]) {
      expect(resolveOnboardingStart({ emailVerified: true, orgs }).step).not.toBe('install');
    }
  });
});
