import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { badParam, gate, isRole, isSafeSegment, jsonError, NO_STORE, planLimitResponse } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import type { PendingInvite, Role } from '@/src/dashboard-types';

type Params = { params: Promise<{ org: string }> };
type Created = { id: string; email: string; role: Role; expiresAt: string; token?: unknown };

const BAD_BODY = 'Enter a valid email address and choose a role.';

const path = (org: string) => `/v1/orgs/${org}/invites`;

/** `notFound` is the 404 copy: the org for a read, the invite's app for a create. */
function failure(res: { status: number; error: string; limit?: string }, notFound: string): Response {
  const limited = planLimitResponse(res);
  if (limited) return limited;
  switch (res.status) {
    case 400: return jsonError(BAD_BODY, 400);
    case 401: return jsonError('unauthorized', 401);
    case 403: return jsonError('Only workspace admins can invite teammates.', 403);
    case 404: return jsonError(notFound, 404);
    case 429: return jsonError('Too many invites — try again in a minute.', 429);
    default: return jsonError(safeUpstreamMessage(res.status, 'generic'), 502);
  }
}

/**
 * The accept link. Built here, from the public origin, never by the browser:
 * WEB_ORIGIN, or (local dev, unset) the request's Origin, which the CSRF guard
 * has already matched against Host.
 */
function inviteLink(request: Request, token: string): string {
  const base = process.env.WEB_ORIGIN || request.headers.get('origin')!;
  const url = new URL('/invite', base);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Pending invites (ADMIN+). */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, false);
  if ('response' in g) return g.response;
  const { org } = await params;
  if (!isSafeSegment(org)) return badParam();
  const res = await authedFetch<PendingInvite[]>(path(org), g.session.accessToken);
  if (!res.ok) return failure(res, safeUpstreamMessage(404, 'generic'));
  return NextResponse.json(res.data, { headers: NO_STORE });
}

/**
 * Invites by email + role, and for MEMBER/VIEWER the app they're invited to
 * (`appId`). The API emails the link; it is also returned so the admin can copy it.
 */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const { org } = await params;
  if (!isSafeSegment(org)) return badParam();

  const raw = (await request.json().catch(() => null)) as { email?: unknown; role?: unknown; appId?: unknown } | null;
  const email = raw && typeof raw === 'object' && typeof raw.email === 'string' ? raw.email.trim() : '';
  const role = raw && typeof raw === 'object' ? raw.role : undefined;
  // Absent (or null) for an org-wide invite; otherwise an id the upstream path can't be bent by.
  const appId = raw && typeof raw === 'object' ? raw.appId ?? undefined : undefined;
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 200 || !isRole(role)) return jsonError(BAD_BODY, 400);
  if (appId !== undefined && !isSafeSegment(appId)) return jsonError(BAD_BODY, 400);

  const res = await authedFetch<Created>(path(org), g.session.accessToken, {
    method: 'POST',
    body: JSON.stringify(appId === undefined ? { email, role } : { email, role, appId }),
  });
  // A 404 here means the invite's app is gone, or is another org's (the API answers both alike).
  if (!res.ok) return failure(res, 'That app no longer exists.');
  const { id, expiresAt, token } = res.data;
  if (!isSafeSegment(token)) return jsonError(safeUpstreamMessage(500, 'generic'), 502);
  return NextResponse.json(
    { id, email: res.data.email, role: res.data.role, expiresAt, inviteLink: inviteLink(request, token) },
    { status: 201, headers: NO_STORE },
  );
}
