import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { badParam, gate, isSafeSegment, jsonError, NO_STORE, planLimitResponse } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import type { AppAccessList } from '@/src/dashboard-types';

type Params = { params: Promise<{ id: string }> };

function failure(res: { status: number; error: string; limit?: string }): Response {
  const limited = planLimitResponse(res);
  if (limited) return limited;
  switch (res.status) {
    case 401: return jsonError('unauthorized', 401);
    case 403: return jsonError('Only workspace admins can see who has access.', 403);
    case 404: return jsonError('That app no longer exists.', 404);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(res.status, 'generic'), 502);
  }
}

/** Rebuilt from the known fields only, so nothing else the API ever adds to a row reaches the browser. */
function pick(data: AppAccessList): AppAccessList {
  return {
    people: data.people.map(({ userId, name, email, role, allApps }) => ({ userId, name, email, role, allApps })),
    invites: data.invites.map(({ id, email, role, expiresAt }) => ({ id, email, role, expiresAt })),
    seats: { used: data.seats.used, max: data.seats.max },
  };
}

/** Who can open the app, its pending invites and the org's seat usage (ADMIN+). */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, false);
  if ('response' in g) return g.response;
  const { id } = await params;
  if (!isSafeSegment(id)) return badParam();

  const res = await authedFetch<AppAccessList>(`/v1/apps/${id}/access`, g.session.accessToken);
  if (!res.ok) return failure(res);
  const d = res.data as Partial<AppAccessList> | undefined;
  if (!Array.isArray(d?.people) || !Array.isArray(d.invites) || !d.seats) return failure({ status: 502, error: 'bad body' });
  return NextResponse.json(pick(d as AppAccessList), { headers: NO_STORE });
}
