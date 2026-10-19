import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { gate, jsonError, NO_STORE } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';

const NAME_MAX = 100;

function failure(status: number): Response {
  switch (status) {
    case 400: return jsonError('Enter a name between 1 and 100 characters.', 400);
    case 401: return jsonError('unauthorized', 401);
    case 403: return jsonError(safeUpstreamMessage(403, 'generic'), 403);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(status, 'generic'), 502);
  }
}

/** Renames the signed-in user. Only `name` is forwarded. */
export async function PATCH(request: Request): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;

  const raw = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const value = raw && typeof raw === 'object' ? raw.name : undefined;
  if (typeof value !== 'string') return failure(400);
  const name = value.trim();
  if (name.length < 1 || name.length > NAME_MAX) return failure(400);

  const res = await authedFetch<{ name: string }>('/v1/me', g.session.accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return failure(res.status);
  return NextResponse.json({ name: res.data.name }, { headers: NO_STORE });
}
