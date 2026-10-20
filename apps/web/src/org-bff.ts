import { NextResponse } from 'next/server';
import type { Session } from './auth';
import { rejectCrossSiteAuthPost } from './same-origin-guard';
import { sessionOr401 } from './route-session';
import { ROLES, type Role } from './dashboard-types';
import { planLimitCopy } from './plan-limits';

/*
 * Shared plumbing for the member/invite BFF route handlers:
 * rejectCrossSiteAuthPost (mutations) → sessionOr401, with every response
 * no-store.
 */

export const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Path params (org id, invite id, membership id, invite token) are cuid /
 * base64url values. Anything else — notably `.` and `..`, which collapse the
 * upstream path when spliced into a URL even after encodeURIComponent — is
 * refused before an upstream URL is built.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,512}$/;
export const isSafeSegment = (s: unknown): s is string => typeof s === 'string' && SAFE_SEGMENT.test(s);

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

export const jsonError = (error: string, status: number): Response =>
  NextResponse.json({ error }, { status, headers: NO_STORE });

export const badParam = (): Response => jsonError('Invalid request.', 400);

/**
 * A plan-limit refusal (`403 { error: 'plan-limit', limit }`) as its fixed
 * copy plus the `limit`, so the UI can tell which one it hit. Null for any
 * other failure, including a 403 naming a limit this build doesn't know.
 */
export function planLimitResponse(res: { status: number; error: string; limit?: string }): Response | null {
  if (res.status !== 403 || res.error !== 'plan-limit') return null;
  const copy = planLimitCopy(res.limit);
  if (copy === null) return null;
  return NextResponse.json({ error: copy, limit: res.limit }, { status: 403, headers: NO_STORE });
}

/** The session to call upstream with, or the response to return. Mutations are CSRF-checked first. */
export async function gate(request: Request, mutation: boolean): Promise<{ session: Session } | { response: Response }> {
  if (mutation && rejectCrossSiteAuthPost(request)) return { response: jsonError('forbidden', 403) };
  const g = await sessionOr401();
  if ('response' in g) return { response: jsonError('unauthorized', 401) };
  return g;
}
