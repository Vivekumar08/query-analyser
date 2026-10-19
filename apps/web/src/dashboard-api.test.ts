// apps/web/src/dashboard-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({ authedFetch: vi.fn(async () => ({ ok: true, data: [] })) }));
import { authedFetch } from './api';
import { listApps, listQueries, getQuery, getSeries, getSampleKey, listMembers, listInvites } from './dashboard-api';

describe('dashboard-api', () => {
  beforeEach(() => vi.mocked(authedFetch).mockClear());
  it('encodes path segments', async () => {
    await listApps('t', 'ac/me');
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/orgs/ac%2Fme/apps');
    expect(vi.mocked(authedFetch).mock.calls[0]![1]).toBe('t');
  });
  it('passes the API query through', async () => {
    await listQueries('t', 'a1', 'from=x&to=y&sort=count&limit=25');
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a1/queries?from=x&to=y&sort=count&limit=25');
  });
  it('detail is all-time (no window); series carries the window', async () => {
    await getQuery('t', 'a1', 'h#1');
    await getSeries('t', 'a1', 'h#1', { from: 'f', to: 'g' });
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a1/queries/h%231');
    expect(vi.mocked(authedFetch).mock.calls[1]![0]).toBe('/v1/apps/a1/queries/h%231/series?from=f&to=g');
  });
  it('sample-key status is per app', async () => {
    await getSampleKey('t', 'a/1');
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a%2F1/sample-key');
  });
  it('members and pending invites are per org id', async () => {
    await listMembers('t', 'o/1');
    await listInvites('t', 'o/1');
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/orgs/o%2F1/members');
    expect(vi.mocked(authedFetch).mock.calls[1]![0]).toBe('/v1/orgs/o%2F1/invites');
  });
});
