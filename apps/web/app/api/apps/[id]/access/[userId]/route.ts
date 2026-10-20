import { authedFetch } from '@/src/api';
import { badParam, gate, isSafeSegment, jsonError, NO_STORE, planLimitResponse } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';

type Params = { params: Promise<{ id: string; userId: string }> };

function failure(res: { status: number; error: string; limit?: string }): Response {
  const limited = planLimitResponse(res);
  if (limited) return limited;
  switch (res.status) {
    case 401: return jsonError('unauthorized', 401);
    case 403: return jsonError('Only workspace admins can remove access.', 403);
    case 404: return jsonError('That person no longer has access to this app.', 404);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(res.status, 'generic'), 502);
  }
}

/** Removes one person's access to the app (ADMIN+). Their membership, and any other apps, stay. */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const { id, userId } = await params;
  if (!isSafeSegment(id) || !isSafeSegment(userId)) return badParam();

  const res = await authedFetch(`/v1/apps/${id}/access/${userId}`, g.session.accessToken, { method: 'DELETE' });
  if (!res.ok) return failure(res);
  return new Response(null, { status: 204, headers: NO_STORE });
}
