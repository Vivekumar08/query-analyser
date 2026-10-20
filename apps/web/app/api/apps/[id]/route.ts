import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { badParam, gate, isSafeSegment, jsonError, NO_STORE, planLimitResponse } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import { LAST_APP_COOKIE } from '@/src/landing';

type Params = { params: Promise<{ id: string }> };

function failure(res: { status: number; error: string; limit?: string }): Response {
  const limited = planLimitResponse(res);
  if (limited) return limited;
  switch (res.status) {
    case 401: return jsonError('unauthorized', 401);
    case 403: return jsonError('Only workspace admins can delete apps.', 403);
    case 404: return jsonError('That app no longer exists.', 404);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(res.status, 'generic'), 502);
  }
}

/** Deletes the app (ADMIN+), with its keys, data, access rows and app invites. */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const { id } = await params;
  if (!isSafeSegment(id)) return badParam();

  const res = await authedFetch(`/v1/apps/${id}`, g.session.accessToken, { method: 'DELETE' });
  if (!res.ok) return failure(res);

  const out = new NextResponse(null, { status: 204, headers: NO_STORE });
  // qa_last_app is scoped to /dashboard, so this handler can't read it to
  // check it names this app. Cleared unconditionally; landing ignores a
  // missing value and picks the first app left.
  out.cookies.set(LAST_APP_COOKIE, '', { path: '/dashboard', maxAge: 0 });
  return out;
}
