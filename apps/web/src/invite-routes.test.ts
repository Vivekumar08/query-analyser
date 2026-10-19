import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { GET as listInvites, POST as createInvite } from '@/app/api/orgs/[org]/invites/route';
import { DELETE as revokeInvite } from '@/app/api/orgs/[org]/invites/[id]/route';
import { PATCH as changeRole, DELETE as removeMember } from '@/app/api/orgs/[org]/members/[id]/route';
import { POST as acceptInvite } from '@/app/api/invites/accept/route';

const ORIGIN = 'https://app.test';
const orgCtx = (org = 'org1') => ({ params: Promise.resolve({ org }) });
const idCtx = (id = 'x1', org = 'org1') => ({ params: Promise.resolve({ org, id }) });
const req = (method: string, body?: unknown, origin = ORIGIN) => new Request(`${ORIGIN}/api/x`, {
  method,
  headers: { 'content-type': 'application/json', origin, host: 'app.test' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const upstream = (status: number, error = 'x', code?: string) =>
  vi.mocked(authedFetch).mockResolvedValue({ ok: false, status, error, code });
const call = (n = 0) => vi.mocked(authedFetch).mock.calls[n]!;

beforeEach(() => {
  process.env.WEB_ORIGIN = ORIGIN;
  vi.mocked(getSession).mockResolvedValue({ accessToken: 'tok', user: {} } as never);
  vi.mocked(authedFetch).mockReset();
});

describe('cross-site requests', () => {
  it('every mutation route returns 403 with no-store, API untouched', async () => {
    const evil = 'https://evil.test';
    const responses = [
      await createInvite(req('POST', { email: 'a@b.co', role: 'MEMBER' }, evil), orgCtx()),
      await revokeInvite(req('DELETE', undefined, evil), idCtx()),
      await changeRole(req('PATCH', { role: 'ADMIN' }, evil), idCtx()),
      await removeMember(req('DELETE', undefined, evil), idCtx()),
      await acceptInvite(req('POST', { token: 'abc' }, evil)),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(authedFetch).not.toHaveBeenCalled();
  });
});

describe('path params', () => {
  it('rejects ".", ".." and other unsafe segments with 400 before building the upstream URL', async () => {
    for (const bad of ['.', '..', 'a/b', 'a%2Fb', 'a.b', '']) {
      expect((await listInvites(new Request(`${ORIGIN}/api/x`), orgCtx(bad))).status).toBe(400);
      expect((await createInvite(req('POST', { email: 'a@b.co', role: 'MEMBER' }), orgCtx(bad))).status).toBe(400);
      expect((await revokeInvite(req('DELETE'), idCtx(bad))).status).toBe(400);
      expect((await revokeInvite(req('DELETE'), idCtx('x1', bad))).status).toBe(400);
      expect((await changeRole(req('PATCH', { role: 'ADMIN' }), idCtx(bad))).status).toBe(400);
      expect((await removeMember(req('DELETE'), idCtx(bad))).status).toBe(400);
      expect((await acceptInvite(req('POST', { token: bad }))).status).toBe(400);
    }
    expect(authedFetch).not.toHaveBeenCalled();
  });
});

describe('sessions', () => {
  it('no session → 401, API untouched', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    expect((await listInvites(new Request(`${ORIGIN}/api/x`), orgCtx())).status).toBe(401);
    expect((await createInvite(req('POST', { email: 'a@b.co', role: 'MEMBER' }), orgCtx())).status).toBe(401);
    expect((await acceptInvite(req('POST', { token: 'abc' }))).status).toBe(401);
    expect(authedFetch).not.toHaveBeenCalled();
  });
});

describe('GET invites', () => {
  it('passes the pending list through with no-store', async () => {
    const rows = [{ id: 'i1', email: 'a@b.co', role: 'MEMBER', expiresAt: 'e', createdAt: 'c' }];
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: rows });
    const res = await listInvites(new Request(`${ORIGIN}/api/x`), orgCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(rows);
    expect(call()[0]).toBe('/v1/orgs/org1/invites');
    expect(call()[1]).toBe('tok');
  });
});

describe('POST invite', () => {
  it('forwards only {email, role} and returns an inviteLink built from WEB_ORIGIN', async () => {
    vi.mocked(authedFetch).mockResolvedValue({
      ok: true,
      data: { id: 'i1', email: 'a@b.co', role: 'ADMIN', expiresAt: 'e', token: 'tOk_en-1' },
    });
    const res = await createInvite(req('POST', { email: 'a@b.co', role: 'ADMIN', orgId: 'other', extra: 1 }), orgCtx());
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const data = await res.json();
    expect(data).toEqual({ id: 'i1', email: 'a@b.co', role: 'ADMIN', expiresAt: 'e', inviteLink: `${ORIGIN}/invite?token=tOk_en-1` });
    expect(data).not.toHaveProperty('token');
    const [path, token, init] = call();
    expect(path).toBe('/v1/orgs/org1/invites');
    expect(token).toBe('tok');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ email: 'a@b.co', role: 'ADMIN' });
  });

  it('a malformed body → 400, API untouched', async () => {
    expect((await createInvite(req('POST', { email: 'nope', role: 'MEMBER' }), orgCtx())).status).toBe(400);
    expect((await createInvite(req('POST', { email: 'a@b.co', role: 'GOD' }), orgCtx())).status).toBe(400);
    expect((await createInvite(req('POST', 'a@b.co'), orgCtx())).status).toBe(400);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('upstream "only an owner can invite an owner" → a safe 403 message', async () => {
    upstream(403, 'only an owner can invite an owner');
    const res = await createInvite(req('POST', { email: 'a@b.co', role: 'OWNER' }), orgCtx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only an owner can invite another owner.' });
  });

  it('any other upstream 403 → "Only workspace admins can invite teammates."', async () => {
    upstream(403, 'insufficient role');
    const res = await createInvite(req('POST', { email: 'a@b.co', role: 'MEMBER' }), orgCtx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only workspace admins can invite teammates.' });
  });

  it('429 → "Too many invites — try again in a minute."', async () => {
    upstream(429, 'Rate limit exceeded, retry in 1 minute');
    const res = await createInvite(req('POST', { email: 'a@b.co', role: 'MEMBER' }), orgCtx());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many invites — try again in a minute.' });
  });

  it('409 at the pending cap → the API\'s message', async () => {
    upstream(409, 'Too many pending invites — revoke some first.');
    const res = await createInvite(req('POST', { email: 'a@b.co', role: 'MEMBER' }), orgCtx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Too many pending invites — revoke some first.' });
  });

  it('401 stays 401; 5xx → 502 without the upstream detail', async () => {
    upstream(401, 'expired');
    expect((await createInvite(req('POST', { email: 'a@b.co', role: 'MEMBER' }), orgCtx())).status).toBe(401);
    upstream(500, 'stack trace detail');
    const res = await createInvite(req('POST', { email: 'a@b.co', role: 'MEMBER' }), orgCtx());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('detail');
  });
});

describe('DELETE invite (revoke)', () => {
  it('forwards and returns 204 with no-store', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: undefined });
    const res = await revokeInvite(req('DELETE'), idCtx('i1'));
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(call()[0]).toBe('/v1/orgs/org1/invites/i1');
    expect(call()[2]!.method).toBe('DELETE');
  });
  it('404 → a clear message', async () => {
    upstream(404, 'Not Found');
    const res = await revokeInvite(req('DELETE'), idCtx('i1'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'That invite was already accepted, revoked or has expired.' });
  });
});

describe('PATCH member role', () => {
  it('forwards only {role}', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { id: 'm1', role: 'ADMIN' } });
    const res = await changeRole(req('PATCH', { role: 'ADMIN', userId: 'u2' }), idCtx('m1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'm1', role: 'ADMIN' });
    expect(call()[0]).toBe('/v1/orgs/org1/members/m1');
    expect(call()[2]!.method).toBe('PATCH');
    expect(JSON.parse(call()[2]!.body as string)).toEqual({ role: 'ADMIN' });
  });
  it('an unknown role → 400, API untouched', async () => {
    expect((await changeRole(req('PATCH', { role: 'GOD' }), idCtx('m1'))).status).toBe(400);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('409 last owner, 403 and 404 → clear messages', async () => {
    upstream(409, 'organization must keep at least one owner');
    let res = await changeRole(req('PATCH', { role: 'MEMBER' }), idCtx('m1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A workspace must keep at least one owner.' });
    upstream(403, 'insufficient role');
    res = await changeRole(req('PATCH', { role: 'MEMBER' }), idCtx('m1'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only owners can change roles or remove members.' });
    upstream(404, 'Not Found');
    res = await changeRole(req('PATCH', { role: 'MEMBER' }), idCtx('m1'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'That person is no longer a member of this workspace.' });
  });
});

describe('DELETE member', () => {
  it('forwards and returns 204', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: undefined });
    const res = await removeMember(req('DELETE'), idCtx('m1'));
    expect(res.status).toBe(204);
    expect(call()[0]).toBe('/v1/orgs/org1/members/m1');
    expect(call()[2]!.method).toBe('DELETE');
  });
  it('409 last owner → clear message', async () => {
    upstream(409, 'organization must keep at least one owner');
    const res = await removeMember(req('DELETE'), idCtx('m1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A workspace must keep at least one owner.' });
  });
});

describe('POST accept', () => {
  it('POSTs the token to the API path and returns 200 with no-store', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { orgId: 'org1', role: 'MEMBER' } });
    const res = await acceptInvite(req('POST', { token: 'tOk_en-1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(call()[0]).toBe('/v1/invites/tOk_en-1/accept');
    expect(call()[2]!.method).toBe('POST');
  });

  it('410 and 404 (revoked) → "This invite has expired or was already used."', async () => {
    for (const status of [410, 404]) {
      upstream(status);
      const res = await acceptInvite(req('POST', { token: 'abc' }));
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: 'This invite has expired or was already used.' });
    }
  });

  it('403 wrong email → "This invite was sent to a different email address."', async () => {
    upstream(403, 'invite was issued to a different email');
    const res = await acceptInvite(req('POST', { token: 'abc' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This invite was sent to a different email address.' });
  });

  it('403 for an unverified email or a suspended workspace says so', async () => {
    upstream(403, 'email not verified', 'email_not_verified');
    // The code lets the invite page keep the pending invite for after verification.
    expect(await (await acceptInvite(req('POST', { token: 'abc' }))).json())
      .toEqual({ error: 'Confirm your email address first, then open the invite link again.', code: 'email_not_verified' });
    upstream(403, 'organization suspended');
    expect(await (await acceptInvite(req('POST', { token: 'abc' }))).json())
      .toEqual({ error: 'This workspace is suspended and can\'t take new members.' });
  });

  it('409 → "You\'re already a member."', async () => {
    upstream(409, 'already a member');
    const res = await acceptInvite(req('POST', { token: 'abc' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "You're already a member." });
  });

  it('a missing token → 400, API untouched', async () => {
    expect((await acceptInvite(req('POST', {}))).status).toBe(400);
    expect((await acceptInvite(req('POST', { token: 'x'.repeat(600) }))).status).toBe(400);
    expect(authedFetch).not.toHaveBeenCalled();
  });
});
