import { ROLES, ROLE_LABEL, type MemberApp, type PlanLimits, type Role } from './dashboard-types';

/** What a `403 { error: 'plan-limit', limit }` refusal is about (apps/api/src/plans.ts). */
export type LimitKind = 'orgs' | 'apps' | 'seats' | 'role';

/** The copy for each refusal, verbatim from the spec. */
export const PLAN_LIMIT_COPY: Record<LimitKind, string> = {
  orgs: 'During the beta, each account can create one organisation. More with paid plans.',
  apps: 'During the beta, each organisation has one app. Delete it to connect a different one, or upgrade later.',
  seats: 'During the beta, you can invite one teammate. More seats with paid plans.',
  role: 'During the beta, teammates join as Members.',
};

const isLimitKind = (v: unknown): v is LimitKind => typeof v === 'string' && Object.hasOwn(PLAN_LIMIT_COPY, v);

/** The copy for a refusal's `limit`, or null for anything that isn't a known one. */
export function planLimitCopy(limit: unknown): string | null {
  return isLimitKind(limit) ? PLAN_LIMIT_COPY[limit] : null;
}

/**
 * Whether "New organisation" is enabled. Anyone who owns no org may create
 * one; otherwise the owned count must be below the largest `ownedOrgs` among
 * the orgs they own. A hint only: the API counts the orgs the user created,
 * and is the real gate.
 */
export function canCreateOrg(orgs: { role: Role; limits: PlanLimits }[]): boolean {
  const owned = orgs.filter((o) => o.role === 'OWNER');
  if (owned.length === 0) return true;
  return owned.length < Math.max(...owned.map((o) => o.limits.ownedOrgs));
}

/** Whether "New app" is enabled for an org with `appCount` apps. */
export function canCreateApp(limits: PlanLimits, appCount: number): boolean {
  return appCount < limits.apps;
}

export const retentionNote = (days: number): string => `Kept for ${days} days on your plan`;

export const seatsLabel = (s: { used: number; max: number }): string => `${s.used} of ${s.max} seats used`;

/** A member's apps grouped by role in ROLES order, e.g. "Member · Shop, Admin panel; Viewer · Docs". */
export function appAccessSummary(m: { allApps: boolean; apps: MemberApp[] }): string {
  if (m.allApps) return 'All apps';
  if (m.apps.length === 0) return 'No apps';
  return ROLES
    .map((role) => ({ role, names: m.apps.filter((a) => a.role === role).map((a) => a.name) }))
    .filter((g) => g.names.length > 0)
    .map((g) => `${ROLE_LABEL[g.role]} · ${g.names.join(', ')}`)
    .join('; ');
}
