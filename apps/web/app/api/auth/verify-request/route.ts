import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { upstreamAuthHeaders } from '@/src/upstream-headers';

/**
 * Resend the verification email. The upstream route is authenticated (it
 * identifies the user from the bearer token and takes no body), so this uses
 * the session's token plus the forwarded client IP for its rate limit. Same
 * 202 whatever happens upstream.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  await authedFetch('/v1/auth/verify/request', gate.session.accessToken, {
    method: 'POST',
    headers: upstreamAuthHeaders(request),
  }).catch(() => null);
  return NextResponse.json({ status: 'sent' }, { status: 202 });
}
