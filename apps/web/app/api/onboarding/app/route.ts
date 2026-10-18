import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { listOrgs } from '@/src/dashboard-api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { safeUpstreamMessage } from '@/src/upstream-errors';

/** The API requires an `env` (no default); first apps are production. */
const FIRST_APP_ENV = 'production';

/**
 * Creates the app and its first ingest key. The key's plaintext leaves the
 * server exactly here, once, in this JSON body — never a cookie, URL or
 * redirect — and `no-store` keeps any cache from holding it. It is not logged.
 *
 * The client sends the org SLUG (that is what the onboarding URL carries); the
 * API's `:org` param is the org ID (Ruling C1-5), so it is resolved here from
 * the caller's own memberships — which also means a slug the user does not
 * belong to is a 404 before anything is created.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  const t = gate.session.accessToken;

  const body = (await request.json().catch(() => null)) as { org?: unknown; name?: unknown } | null;
  const orgSlug = typeof body?.org === 'string' ? body.org : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!orgSlug || name.length < 1 || name.length > 60) {
    return NextResponse.json({ error: 'App name must be 1–60 characters.' }, { status: 400 });
  }

  const orgs = await listOrgs(t);
  if (!orgs.ok) {
    return NextResponse.json({ error: safeUpstreamMessage(orgs.status, 'generic') }, { status: orgs.status === 401 ? 401 : 502 });
  }
  const org = orgs.data.find((o) => o.slug === orgSlug);
  if (!org) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  const created = await authedFetch<{ id: string; name: string }>(`/v1/orgs/${encodeURIComponent(org.id)}/apps`, t, {
    method: 'POST',
    body: JSON.stringify({ name, env: FIRST_APP_ENV }),
  });
  if (!created.ok) {
    return NextResponse.json({ error: safeUpstreamMessage(created.status, 'app') }, { status: created.status >= 500 || created.status === 0 ? 502 : created.status });
  }
  const key = await authedFetch<{ key: string }>(`/v1/apps/${encodeURIComponent(created.data.id)}/keys`, t, { method: 'POST' });

  const appBody = { id: created.data.id, name: created.data.name };
  const headers = { 'cache-control': 'no-store' };
  if (key.ok) return NextResponse.json({ app: appBody, key: key.data.key }, { status: 201, headers });
  // The app exists; the UI offers a recovery path. Creating keys needs ADMIN,
  // so a MEMBER gets 'forbidden' (no retry button), anything else 'failed'.
  return NextResponse.json(
    { app: appBody, key: null, keyError: key.status === 403 ? 'forbidden' : 'failed' },
    { status: 201, headers },
  );
}
