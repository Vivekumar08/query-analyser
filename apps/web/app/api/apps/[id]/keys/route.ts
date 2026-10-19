import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import { badParam, isSafeSegment } from '@/src/org-bff';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Creates a fresh ingest key for an app. Like the onboarding app route, the
 * plaintext leaves the server exactly once, in this JSON body (no cookie, URL
 * or redirect), and is never logged.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  const { id } = await params;
  if (!isSafeSegment(id)) return badParam();

  const res = await authedFetch<{ key: string }>(`/v1/apps/${encodeURIComponent(id)}/keys`, gate.session.accessToken, { method: 'POST' });
  if (!res.ok) {
    if (res.status === 401) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
    if (res.status === 403) {
      return NextResponse.json({ error: 'Only workspace admins can create keys — ask an admin.' }, { status: 403, headers: NO_STORE });
    }
    const status = res.status === 404 ? 404 : res.status >= 500 || res.status === 0 ? 502 : res.status;
    return NextResponse.json({ error: safeUpstreamMessage(res.status, 'generic') }, { status, headers: NO_STORE });
  }
  return NextResponse.json({ key: res.data.key }, { status: 201, headers: NO_STORE });
}
