import type { FastifyReply } from 'fastify';
import type { Role } from './db.js';

/** What a limit refusal is about. `role` means "this role can't be invited on this plan". */
export type LimitKind = 'orgs' | 'apps' | 'seats' | 'role';

export interface PlanLimits {
  /** How many orgs a user may own, taking the largest among the orgs they already own. */
  ownedOrgs: number;
  apps: number;
  /** Distinct people (members and pending invitees) beyond one owner. */
  seats: number;
  invitableRoles: readonly Role[];
  dailyRetentionDays: number;
}

const plan = (limits: PlanLimits): PlanLimits =>
  Object.freeze({ ...limits, invitableRoles: Object.freeze([...limits.invitableRoles]) });

/** Limits per `Organization.plan`. `pro` and `team` exist as data only; ops set them by hand. */
export const PLAN_LIMITS: Readonly<Record<'free' | 'pro' | 'team', PlanLimits>> = Object.freeze({
  free: plan({ ownedOrgs: 1, apps: 1, seats: 1, invitableRoles: ['MEMBER'], dailyRetentionDays: 30 }),
  pro: plan({ ownedOrgs: 1, apps: 3, seats: 5, invitableRoles: ['ADMIN', 'MEMBER', 'VIEWER'], dailyRetentionDays: 90 }),
  team: plan({ ownedOrgs: 3, apps: 10, seats: 20, invitableRoles: ['ADMIN', 'MEMBER', 'VIEWER'], dailyRetentionDays: 365 }),
});

/** The limits for a plan string. Anything unknown (including prototype keys) gets `free`. */
export function limitsFor(plan: string): PlanLimits {
  return Object.hasOwn(PLAN_LIMITS, plan) ? PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS] : PLAN_LIMITS.free;
}

/** The `RETENTION_GRACE_UNTIL` default: roughly 90 days after the plans shipped. */
export const DEFAULT_RETENTION_GRACE_UNTIL = '2027-01-31';

/** Daily retention before the grace ends: the 90 days every org had before plans existed. */
const GRACE_RETENTION_DAYS = 90;

/**
 * Days of daily rollups an org on `plan` keeps at `now`. Until `graceUntil`
 * nobody keeps less than the pre-plans 90 days, so existing history is left
 * alone; from that instant on, the plan's own value applies. The nightly prune
 * and the limits sent to the web both use this, so the dashboard never offers
 * a range the data no longer covers, nor hides one it still does.
 */
export function effectiveRetentionDays(plan: string, now: Date, graceUntil: Date): number {
  const days = limitsFor(plan).dailyRetentionDays;
  return now < graceUntil ? Math.max(days, GRACE_RETENTION_DAYS) : days;
}

/** Thrown inside a creating transaction, so it rolls back, and mapped with `sendPlanLimit`. */
export class PlanLimitError extends Error {
  constructor(readonly limit: LimitKind, readonly max: number) {
    super(`plan limit: ${limit} (max ${max})`);
    this.name = 'PlanLimitError';
  }
}

export function sendPlanLimit(reply: FastifyReply, e: PlanLimitError) {
  return reply.code(403).send({ error: 'plan-limit', limit: e.limit, max: e.max });
}
