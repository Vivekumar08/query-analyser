import { NextResponse } from 'next/server';
import { apiOrigin } from '@/src/api';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const upstream = await fetch(`${apiOrigin()}/v1/auth/verify/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
