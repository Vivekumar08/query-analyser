import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { gate, isSafeSegment, jsonError, NO_STORE } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';

const GONE = 'This invite has expired or was already used.';

/**
 * Accepts an invite for the signed-in user. The token arrives in the body
 * (never a URL of ours, which would land in logs) and is never logged here.
 * The API takes it as a path segment and redacts it from its own request log.
 */
export async function POST(request: Request): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;

  const raw = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = raw && typeof raw === 'object' ? raw.token : undefined;
  if (!isSafeSegment(token)) return jsonError('This invite link is incomplete. Use the link from your email.', 400);

  const res = await authedFetch<{ orgId: string }>(`/v1/invites/${token}/accept`, g.session.accessToken, { method: 'POST' });
  if (res.ok) return NextResponse.json({ orgId: res.data.orgId }, { headers: NO_STORE });

  switch (res.status) {
    case 401: return jsonError('unauthorized', 401);
    // 404 is a revoked (deleted) or unknown token: to the invitee, the same as used/expired.
    case 404:
    case 410: return jsonError(GONE, 410);
    case 403:
      if (res.code === 'email_not_verified') return jsonError('Confirm your email address first, then open the invite link again.', 403);
      if (res.error === 'organization suspended') return jsonError("This workspace is suspended and can't take new members.", 403);
      return jsonError('This invite was sent to a different email address.', 403);
    case 409: return jsonError("You're already a member.", 409);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(res.status, 'generic'), 502);
  }
}
