import { authedFetch } from '@/src/api';
import { badParam, gate, isSafeSegment, jsonError, NO_STORE } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';

type Params = { params: Promise<{ org: string; id: string }> };

/** Revokes a pending invite (ADMIN+). The API deletes it, so its link then 404s. */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const { org, id } = await params;
  if (!isSafeSegment(org) || !isSafeSegment(id)) return badParam();

  const res = await authedFetch(`/v1/orgs/${org}/invites/${id}`, g.session.accessToken, { method: 'DELETE' });
  if (res.ok) return new Response(null, { status: 204, headers: NO_STORE });
  switch (res.status) {
    case 401: return jsonError('unauthorized', 401);
    case 403: return jsonError('Only workspace admins can revoke invites.', 403);
    case 404: return jsonError('That invite was already accepted, revoked or has expired.', 404);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(res.status, 'generic'), 502);
  }
}
