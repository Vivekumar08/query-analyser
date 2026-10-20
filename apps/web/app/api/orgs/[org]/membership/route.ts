import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { badParam, gate, isSafeSegment, jsonError, NO_STORE } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import { LAST_APP_COOKIE } from '@/src/landing';

type Params = { params: Promise<{ org: string }> };

function failure(status: number, upstreamError: string): Response {
  switch (status) {
    case 401: return jsonError('unauthorized', 401);
    case 403:
      // rbac.ts sends this exact code for a suspended org; other 403s stay generic.
      if (upstreamError === 'organization suspended') {
        return jsonError("This organisation is suspended, so you can't leave it right now.", 403);
      }
      return jsonError(safeUpstreamMessage(403, 'generic'), 403);
    case 404: return jsonError("You're no longer a member of this organisation.", 404);
    // The API's only 409 here: the caller is the org's last OWNER.
    case 409: return jsonError("You're the only owner. Make someone else an owner first.", 409);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(status, 'generic'), 502);
  }
}

/** The signed-in user leaves the org. `org` is the org id. */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const { org } = await params;
  if (!isSafeSegment(org)) return badParam();

  const res = await authedFetch(`/v1/orgs/${org}/membership`, g.session.accessToken, { method: 'DELETE' });
  if (!res.ok) return failure(res.status, res.error);

  const out = new NextResponse(null, { status: 204, headers: NO_STORE });
  // qa_last_app is scoped to /dashboard and holds a slug, so this handler can
  // neither read it nor match it against the org id. Cleared unconditionally;
  // resolveLanding already ignores a stale value.
  out.cookies.set(LAST_APP_COOKIE, '', { path: '/dashboard', maxAge: 0 });
  return out;
}
