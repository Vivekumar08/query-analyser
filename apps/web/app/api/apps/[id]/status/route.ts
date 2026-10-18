import { NextResponse } from 'next/server';
import { getApp } from '@/src/dashboard-api';
import { sessionOr401 } from '@/src/route-session';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  const { id } = await params;
  const res = await getApp(gate.session.accessToken, id);
  const headers = { 'cache-control': 'no-store' };
  if (!res.ok) {
    return NextResponse.json({ error: 'not found' }, { status: res.status === 401 ? 401 : res.status >= 500 || res.status === 0 ? 502 : 404, headers });
  }
  return NextResponse.json({ lastSeenAt: res.data.ingest.lastSeenAt }, { headers });
}
