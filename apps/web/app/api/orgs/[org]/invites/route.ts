import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { badParam, gate, isRole, isSafeSegment, jsonError, NO_STORE } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import type { PendingInvite, Role } from '@/src/dashboard-types';

type Params = { params: Promise<{ org: string }> };
type Created = { id: string; email: string; role: Role; expiresAt: string; token?: unknown };

const BAD_BODY = 'Enter a valid email address and choose a role.';
const OWNER_ONLY = 'only an owner can invite an owner';
const CAP = 'Too many pending invites — revoke some first.';

const path = (org: string) => `/v1/orgs/${org}/invites`;

function failure(res: { status: number; error: string }): Response {
  switch (res.status) {
    case 400: return jsonError(BAD_BODY, 400);
    case 401: return jsonError('unauthorized', 401);
    case 403:
      return jsonError(res.error === OWNER_ONLY ? 'Only an owner can invite another owner.' : 'Only workspace admins can invite teammates.', 403);
    // The only 409 is the pending-invite cap (Ruling C9-1); its message is fixed here, not echoed.
    case 409: return jsonError(CAP, 409);
    case 429: return jsonError('Too many invites — try again in a minute.', 429);
    case 404: return jsonError(safeUpstreamMessage(404, 'generic'), 404);
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
  if (!res.ok) return failure(res);
  return NextResponse.json(res.data, { headers: NO_STORE });
}

/** Invites by email + role. The API emails the link; it is also returned so the admin can copy it. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const { org } = await params;
  if (!isSafeSegment(org)) return badParam();

  const raw = (await request.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
  const email = raw && typeof raw === 'object' && typeof raw.email === 'string' ? raw.email.trim() : '';
  const role = raw && typeof raw === 'object' ? raw.role : undefined;
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 200 || !isRole(role)) return jsonError(BAD_BODY, 400);

  const res = await authedFetch<Created>(path(org), g.session.accessToken, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) return failure(res);
  const { id, expiresAt, token } = res.data;
  if (!isSafeSegment(token)) return jsonError(safeUpstreamMessage(500, 'generic'), 502);
  return NextResponse.json(
    { id, email: res.data.email, role: res.data.role, expiresAt, inviteLink: inviteLink(request, token) },
    { status: 201, headers: NO_STORE },
  );
}
