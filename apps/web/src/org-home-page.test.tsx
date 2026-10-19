// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
  notFound: vi.fn(() => { throw new Error('NOT_FOUND'); }),
}));
const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/navigation', () => ({
  redirect: nav.redirect,
  notFound: nav.notFound,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'qa_last_app' && cookieJar.value ? { value: cookieJar.value } : undefined) }),
}));
vi.mock('@/src/auth', () => ({ requireSession: vi.fn() }));
vi.mock('@/src/dashboard-api', () => ({ listOrgs: vi.fn(), listApps: vi.fn() }));

import OrgPage from '@/app/dashboard/[org]/page';
import { requireSession } from '@/src/auth';
import { listApps, listOrgs } from '@/src/dashboard-api';

const ORGS = [
  { id: 'o1', slug: 'team', name: 'Team', plan: 'free', createdAt: 'c', role: 'MEMBER' },
  { id: 'o2', slug: 'other', name: 'Other', plan: 'free', createdAt: 'c', role: 'OWNER' },
];
const page = (org: string) => OrgPage({ params: Promise.resolve({ org }) });

beforeEach(() => {
  cookieJar.value = undefined;
  nav.redirect.mockClear();
  nav.notFound.mockClear();
  vi.mocked(requireSession).mockResolvedValue({ accessToken: 'tok', user: { emailVerifiedAt: 'v' } } as never);
  vi.mocked(listOrgs).mockReset().mockResolvedValue({ ok: true, data: ORGS } as never);
  vi.mocked(listApps).mockReset();
});
afterEach(cleanup);

describe('/dashboard/[org]', () => {
  it('an org with no apps renders the org home', async () => {
    vi.mocked(listApps).mockResolvedValue({ ok: true, data: [] } as never);
    render(await page('team'));
    expect(screen.getByRole('heading', { level: 1, name: 'Team' })).toBeTruthy();
    expect(screen.getByText('No apps yet. Ask an admin to connect one.')).toBeTruthy();
    // The API is asked by org id, never by the URL slug.
    expect(vi.mocked(listApps).mock.calls[0]).toEqual(['tok', 'o1']);
  });

  it('a suspended org (apps 403) says so instead of crashing, 404ing or redirecting (Review Focus)', async () => {
    vi.mocked(listApps).mockResolvedValue({ ok: false, status: 403, error: 'organization suspended' } as never);
    render(await page('team'));
    expect(screen.getByText('This organisation is suspended.')).toBeTruthy();
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it('an org with apps redirects to the remembered app when it belongs to this org', async () => {
    cookieJar.value = encodeURIComponent('team/a2');
    vi.mocked(listApps).mockResolvedValue({ ok: true, data: [{ id: 'a1' }, { id: 'a2' }] } as never);
    await expect(page('team')).rejects.toThrow('REDIRECT /dashboard/team/a2/queries');
  });

  it('a remembered app from another org is ignored: first app instead', async () => {
    cookieJar.value = encodeURIComponent('other/a2');
    vi.mocked(listApps).mockResolvedValue({ ok: true, data: [{ id: 'a1' }, { id: 'a2' }] } as never);
    await expect(page('team')).rejects.toThrow('REDIRECT /dashboard/team/a1/queries');
  });

  it('an org the user is not in is a 404, and its apps are never requested', async () => {
    await expect(page('nope')).rejects.toThrow('NOT_FOUND');
    expect(listApps).not.toHaveBeenCalled();
  });

  it('an unsafe slug is a 404 before any API call', async () => {
    for (const bad of ['..', 'a/b', '']) {
      await expect(page(bad)).rejects.toThrow('NOT_FOUND');
    }
    expect(listOrgs).not.toHaveBeenCalled();
  });

  it('apps 404 (access lost) is a 404', async () => {
    vi.mocked(listApps).mockResolvedValue({ ok: false, status: 404, error: 'x' } as never);
    await expect(page('team')).rejects.toThrow('NOT_FOUND');
  });

  it('a 401 from either call refreshes back to this page', async () => {
    vi.mocked(listOrgs).mockResolvedValueOnce({ ok: false, status: 401, error: 'x' } as never);
    await expect(page('team')).rejects.toThrow('REDIRECT /api/auth/refresh?next=%2Fdashboard%2Fteam');
    vi.mocked(listApps).mockResolvedValue({ ok: false, status: 401, error: 'x' } as never);
    await expect(page('team')).rejects.toThrow('REDIRECT /api/auth/refresh?next=%2Fdashboard%2Fteam');
  });

  it('an outage throws (error boundary), it does not look like an empty org', async () => {
    vi.mocked(listApps).mockResolvedValue({ ok: false, status: 502, error: 'x' } as never);
    await expect(page('team')).rejects.toThrow(/apps/i);
    vi.mocked(listOrgs).mockResolvedValueOnce({ ok: false, status: 500, error: 'x' } as never);
    await expect(page('team')).rejects.toThrow(/organisations|workspaces/i);
  });

  it('an unverified user goes to onboarding', async () => {
    vi.mocked(requireSession).mockResolvedValue({ accessToken: 'tok', user: { emailVerifiedAt: null } } as never);
    await expect(page('team')).rejects.toThrow('REDIRECT /onboarding');
    expect(listOrgs).not.toHaveBeenCalled();
  });
});
