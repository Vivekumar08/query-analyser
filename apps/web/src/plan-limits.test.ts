import { describe, it, expect } from 'vitest';
import {
  appAccessSummary, canCreateApp, canCreateOrg, PLAN_LIMIT_COPY, planLimitCopy, retentionNote, seatsLabel,
} from './plan-limits';
import type { PlanLimits } from './dashboard-types';

const limits = (ownedOrgs: number, apps = 1): PlanLimits =>
  ({ ownedOrgs, apps, seats: 1, invitableRoles: ['MEMBER'], dailyRetentionDays: 30 });

describe('plan-limits', () => {
  it('maps each limit to its copy and ignores unknown ones', () => {
    expect(planLimitCopy('orgs')).toBe('During the beta, each account can create one organisation. More with paid plans.');
    expect(planLimitCopy('apps')).toBe('During the beta, each organisation has one app. Delete it to connect a different one, or upgrade later.');
    expect(planLimitCopy('seats')).toBe('During the beta, you can invite one teammate. More seats with paid plans.');
    expect(planLimitCopy('role')).toBe('During the beta, teammates join as Members.');
    expect(Object.keys(PLAN_LIMIT_COPY).sort()).toEqual(['apps', 'orgs', 'role', 'seats']);
    expect(planLimitCopy('nope')).toBeNull();
    expect(planLimitCopy('toString')).toBeNull();
    expect(planLimitCopy(undefined)).toBeNull();
    expect(planLimitCopy(3)).toBeNull();
  });

  it('canCreateOrg: anyone who owns none; else fewer than the largest owned limit', () => {
    const free = limits(1), team = limits(3);
    expect(canCreateOrg([])).toBe(true);
    expect(canCreateOrg([{ role: 'MEMBER', limits: free }])).toBe(true);
    expect(canCreateOrg([{ role: 'OWNER', limits: free }])).toBe(false);
    expect(canCreateOrg([{ role: 'OWNER', limits: free }, { role: 'OWNER', limits: team }])).toBe(true);
    expect(canCreateOrg([{ role: 'OWNER', limits: team }, { role: 'OWNER', limits: team }, { role: 'OWNER', limits: team }])).toBe(false);
  });

  it('canCreateApp: fewer apps than the plan allows', () => {
    expect(canCreateApp(limits(1, 1), 0)).toBe(true);
    expect(canCreateApp(limits(1, 1), 1)).toBe(false);
    expect(canCreateApp(limits(1, 3), 2)).toBe(true);
  });

  it('labels', () => {
    expect(retentionNote(7)).toBe('Kept for 7 days on your plan');
    expect(seatsLabel({ used: 1, max: 1 })).toBe('1 of 1 seats used');
    expect(appAccessSummary({ allApps: false, apps: [{ id: '1', name: 'Shop', role: 'MEMBER' }, { id: '2', name: 'Admin panel', role: 'MEMBER' }] })).toBe('Member · Shop, Admin panel');
    expect(appAccessSummary({ allApps: false, apps: [{ id: '3', name: 'Docs', role: 'VIEWER' }, { id: '1', name: 'Shop', role: 'MEMBER' }] })).toBe('Member · Shop; Viewer · Docs');
    expect(appAccessSummary({ allApps: true, apps: [] })).toBe('All apps');
    expect(appAccessSummary({ allApps: false, apps: [] })).toBe('No apps');
  });
});
