import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { safeUpstreamMessage } from '@/src/upstream-errors';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 60) {
    return NextResponse.json({ error: 'Workspace name must be 2–60 characters.' }, { status: 400 });
  }

  const res = await authedFetch<{ slug: string; name: string }>('/v1/orgs', gate.session.accessToken, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return NextResponse.json({ error: safeUpstreamMessage(res.status, 'org') }, { status: res.status >= 500 || res.status === 0 ? 502 : res.status });
  return NextResponse.json({ slug: res.data.slug, name: res.data.name }, { status: 201 });
}
