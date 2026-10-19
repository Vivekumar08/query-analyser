import { NextResponse } from 'next/server';
import type { WrappedKey } from '@query-analyser/contract/runtime';
import { authedFetch } from '@/src/api';
// Despite the name, the guard is method-agnostic (content-type + Origin only).
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { safeUpstreamMessage } from '@/src/upstream-errors';
import type { SampleKeyStatus } from '@/src/dashboard-types';
import { badParam, isSafeSegment } from '@/src/org-bff';

const NO_STORE = { 'cache-control': 'no-store' };
const ADMIN_ONLY = 'Only workspace admins can change this.';

type Params = { params: Promise<{ id: string }> };
type Failure = { status: number };

const path = (id: string) => `/v1/apps/${encodeURIComponent(id)}/sample-key`;

function failure(res: Failure, mutation: boolean): Response {
  // 401 stays 401 so the client can send the user through /api/auth/refresh.
  if (res.status === 401) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  if (res.status === 403) {
    return NextResponse.json({ error: mutation ? ADMIN_ONLY : safeUpstreamMessage(403, 'generic') }, { status: 403, headers: NO_STORE });
  }
  if (res.status === 400) {
    return NextResponse.json({ error: "The key couldn't be saved. Please try again." }, { status: 400, headers: NO_STORE });
  }
  const status = res.status === 404 ? 404 : res.status === 429 ? 429 : 502;
  return NextResponse.json({ error: safeUpstreamMessage(res.status, 'generic') }, { status, headers: NO_STORE });
}

const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * Rebuilds the body from the known fields only, so nothing else a client
 * sends — a passphrase, a private key — can ever be forwarded upstream.
 */
function pickKeyBody(raw: unknown): { publicKey: string; wrapped: WrappedKey } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { publicKey, wrapped } = raw as { publicKey?: unknown; wrapped?: unknown };
  if (!isString(publicKey) || !wrapped || typeof wrapped !== 'object') return null;
  const w = wrapped as Record<string, unknown>;
  if (w.v !== 1 || !isString(w.salt) || !isString(w.iv) || !isString(w.ciphertext)) return null;
  if (typeof w.iterations !== 'number' || !Number.isSafeInteger(w.iterations)) return null;
  return { publicKey, wrapped: { v: 1, salt: w.salt, iv: w.iv, iterations: w.iterations, ciphertext: w.ciphertext } };
}

/** The app's sample-key status. Any member may read it; the wrap is useless without the passphrase. */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  const { id } = await params;
  if (!isSafeSegment(id)) return badParam();
  const res = await authedFetch<SampleKeyStatus>(path(id), gate.session.accessToken);
  if (!res.ok) return failure(res, false);
  return NextResponse.json(res.data, { headers: NO_STORE });
}

/** Sets or rotates the key (the API clears stored encrypted samples). Body: the public key and the browser-made wrap only. */
export async function PUT(request: Request, { params }: Params): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;

  const body = pickKeyBody(await request.json().catch(() => null));
  if (!body) return NextResponse.json({ error: "The key couldn't be saved. Please try again." }, { status: 400, headers: NO_STORE });
  const { id } = await params;
  if (!isSafeSegment(id)) return badParam();
  const res = await authedFetch<{ enabled: true; publicKey: string }>(path(id), gate.session.accessToken, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok) return failure(res, true);
  return NextResponse.json({ enabled: true, publicKey: res.data.publicKey }, { headers: NO_STORE });
}

/** Disables real-value samples and clears the stored encrypted samples. */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  const { id } = await params;
  if (!isSafeSegment(id)) return badParam();
  const res = await authedFetch(path(id), gate.session.accessToken, { method: 'DELETE' });
  if (!res.ok) return failure(res, true);
  return new Response(null, { status: 204, headers: NO_STORE });
}
