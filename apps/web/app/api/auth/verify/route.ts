import { NextResponse } from 'next/server';
import { apiOrigin } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { upstreamAuthHeaders } from '@/src/upstream-headers';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const body = await request.text();
  const upstream = await fetch(`${apiOrigin()}/v1/auth/verify/confirm`, {
    method: 'POST',
    headers: upstreamAuthHeaders(request, { 'content-type': 'application/json' }),
    body,
    cache: 'no-store',
  });
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
