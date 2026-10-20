import { describe, it, expect } from 'vitest';
import { limitsFor, PLAN_LIMITS } from './plans.js';

describe('plan limits', () => {
  it('has the beta table', () => {
    expect(limitsFor('free')).toEqual({ ownedOrgs: 1, apps: 1, seats: 1, invitableRoles: ['MEMBER'], dailyRetentionDays: 7 });
    expect(limitsFor('pro')).toEqual({ ownedOrgs: 1, apps: 3, seats: 5, invitableRoles: ['ADMIN', 'MEMBER', 'VIEWER'], dailyRetentionDays: 30 });
    expect(limitsFor('team')).toEqual({ ownedOrgs: 3, apps: 10, seats: 20, invitableRoles: ['ADMIN', 'MEMBER', 'VIEWER'], dailyRetentionDays: 90 });
  });

  it.each(['', 'enterprise', 'FREE', 'constructor', '__proto__', 'toString'])('unknown plan %j gets free limits', (p) =>
    expect(limitsFor(p)).toBe(PLAN_LIMITS.free));
});
