import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
// Despite the name, the guard is method-agnostic (content-type + Origin only).
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { safeUpstreamMessage } from '@/src/upstream-errors';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; adviceId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;

  const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
  if (body?.status !== 'APPLIED' && body?.status !== 'DISMISSED') {
    return NextResponse.json({ error: 'Invalid status.' }, { status: 400 });
  }
  const { id, adviceId } = await params;
  const res = await authedFetch(`/v1/apps/${encodeURIComponent(id)}/advice/${encodeURIComponent(adviceId)}`, gate.session.accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ status: body.status }),
  });
  if (!res.ok) {
    // 401 stays 401 so the client can send the user through /api/auth/refresh.
    const status = res.status === 401 ? 401 : res.status === 404 ? 404 : res.status === 403 ? 403 : res.status >= 500 || res.status === 0 ? 502 : 400;
    const error = res.status === 400 ? "This suggestion can't be updated." : safeUpstreamMessage(res.status, 'generic');
    return NextResponse.json({ error }, { status });
  }
  return NextResponse.json({ status: body.status });
}
