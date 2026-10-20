import { describe, it, expect } from 'vitest';
import { effectiveRetentionDays, limitsFor, PLAN_LIMITS } from './plans.js';

describe('plan limits', () => {
  it('has the beta table', () => {
    expect(limitsFor('free')).toEqual({ ownedOrgs: 1, apps: 1, seats: 1, invitableRoles: ['MEMBER'], dailyRetentionDays: 30 });
    expect(limitsFor('pro')).toEqual({ ownedOrgs: 1, apps: 3, seats: 5, invitableRoles: ['ADMIN', 'MEMBER', 'VIEWER'], dailyRetentionDays: 90 });
    expect(limitsFor('team')).toEqual({ ownedOrgs: 3, apps: 10, seats: 20, invitableRoles: ['ADMIN', 'MEMBER', 'VIEWER'], dailyRetentionDays: 365 });
  });

  it.each(['', 'enterprise', 'FREE', 'constructor', '__proto__', 'toString'])('unknown plan %j gets free limits', (p) =>
    expect(limitsFor(p)).toBe(PLAN_LIMITS.free));
});

describe('effectiveRetentionDays', () => {
  const grace = new Date('2027-01-31T00:00:00.000Z');
  const inside = new Date('2026-10-20T02:00:00.000Z');

  it('keeps at least 90 days for every plan before the grace ends', () => {
    expect(effectiveRetentionDays('free', inside, grace)).toBe(90);
    expect(effectiveRetentionDays('pro', inside, grace)).toBe(90);
    expect(effectiveRetentionDays('team', inside, grace)).toBe(365);
    expect(effectiveRetentionDays('legacy-unknown', inside, grace)).toBe(90);
  });

  it('applies the plan value from the grace instant on', () => {
    expect(effectiveRetentionDays('free', new Date(grace.getTime() - 1), grace)).toBe(90);
    expect(effectiveRetentionDays('free', grace, grace)).toBe(30);
    expect(effectiveRetentionDays('pro', grace, grace)).toBe(90);
    expect(effectiveRetentionDays('team', grace, grace)).toBe(365);
    expect(effectiveRetentionDays('legacy-unknown', grace, grace)).toBe(30);
  });
});
