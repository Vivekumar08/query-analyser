import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { badParam, gate, isRole, isSafeSegment, jsonError, NO_STORE } from '@/src/org-bff';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import type { Role } from '@/src/dashboard-types';

type Params = { params: Promise<{ org: string; id: string }> };

function failure(status: number): Response {
  switch (status) {
    case 400: return jsonError('Choose a valid role.', 400);
    case 401: return jsonError('unauthorized', 401);
    case 403: return jsonError('Only owners can change roles or remove members.', 403);
    case 404: return jsonError('That person is no longer a member of this workspace.', 404);
    // The API's only 409 here: the change would leave the org with no OWNER.
    case 409: return jsonError('A workspace must keep at least one owner.', 409);
    case 429: return jsonError(safeUpstreamMessage(429, 'generic'), 429);
    default: return jsonError(safeUpstreamMessage(status, 'generic'), 502);
  }
}

const path = (org: string, id: string) => `/v1/orgs/${org}/members/${id}`;

/** Changes a member's role (OWNER only). `id` is the membership id. */
export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const { org, id } = await params;
  if (!isSafeSegment(org) || !isSafeSegment(id)) return badParam();

  const raw = (await request.json().catch(() => null)) as { role?: unknown } | null;
  const role = raw && typeof raw === 'object' ? raw.role : undefined;
  if (!isRole(role)) return failure(400);

  const res = await authedFetch<{ id: string; role: Role }>(path(org, id), g.session.accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
  if (!res.ok) return failure(res.status);
  return NextResponse.json({ id: res.data.id, role: res.data.role }, { headers: NO_STORE });
}

/** Removes a member (OWNER only). */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const { org, id } = await params;
  if (!isSafeSegment(org) || !isSafeSegment(id)) return badParam();

  const res = await authedFetch(path(org, id), g.session.accessToken, { method: 'DELETE' });
  if (!res.ok) return failure(res.status);
  return new Response(null, { status: 204, headers: NO_STORE });
}
