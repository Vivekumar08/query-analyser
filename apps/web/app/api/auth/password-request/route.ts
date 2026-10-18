import { NextResponse } from 'next/server';
import { apiOrigin } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { upstreamAuthHeaders } from '@/src/upstream-headers';

/**
 * Starts a password reset (Ruling B21). The API replies 202 whether or not
 * the address has an account, so it cannot be used to probe for accounts;
 * this handler keeps that property by answering the SAME 202 body whatever
 * happened upstream — an error status, a rate limit, or the API being down.
 * Passing the upstream status through would reopen the oracle (and an outage
 * is not something the visitor can act on here anyway).
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;

  await fetch(`${apiOrigin()}/v1/auth/password/request`, {
    method: 'POST',
    headers: upstreamAuthHeaders(request, { 'content-type': 'application/json' }),
    body: await request.text(),
    cache: 'no-store',
  }).catch(() => null);

  return NextResponse.json({ status: 'sent' }, { status: 202 });
}
