// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
  notFound: vi.fn(() => { throw new Error('NOT_FOUND'); }),
}));
vi.mock('next/navigation', () => ({
  redirect: nav.redirect,
  notFound: nav.notFound,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/acme/a1/settings',
}));
vi.mock('@/src/shell-context', () => ({ getShellContext: vi.fn() }));
vi.mock('@/src/dashboard-api', () => ({ getAppAccess: vi.fn(), getSampleKey: vi.fn(), listInvites: vi.fn(), listMembers: vi.fn() }));

import SettingsPage from '@/app/dashboard/[org]/[app]/settings/page';
import { getShellContext } from '@/src/shell-context';
import { getAppAccess, getSampleKey, listInvites, listMembers } from '@/src/dashboard-api';
import type { Role } from '@/src/dashboard-types';

const ctxFor = (role: Role) => ({
  session: { accessToken: 'tok', user: { id: 'u1' } },
  currentOrg: {
    id: 'o1', slug: 'acme', name: 'Acme', role,
    limits: { ownedOrgs: 1, apps: 1, seats: 1, invitableRoles: ['MEMBER'], dailyRetentionDays: 30 },
  },
  app: { id: 'a1', name: 'Shop', orgId: 'o1' },
  orgs: [],
  appsByOrg: {},
});
const page = () => SettingsPage({ params: Promise.resolve({ org: 'acme', app: 'a1' }) });

beforeEach(() => {
  nav.redirect.mockClear();
  nav.notFound.mockClear();
  vi.mocked(getSampleKey).mockReset().mockResolvedValue({ ok: true, data: { enabled: false } } as never);
  vi.mocked(listMembers).mockReset().mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(listInvites).mockReset().mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(getAppAccess).mockReset().mockResolvedValue({ ok: true, data: { people: [], invites: [], seats: { used: 0, max: 1 } } } as never);
});
afterEach(cleanup);

describe('/dashboard/[org]/[app]/settings', () => {
  it.each(['MEMBER', 'VIEWER'] as const)('a %s gets the not-found page and no settings data is fetched', async (role) => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor(role) as never);
    await expect(page()).rejects.toThrow('NOT_FOUND');
    expect(getSampleKey).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
    expect(listInvites).not.toHaveBeenCalled();
    expect(getAppAccess).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'OWNER'] as const)('an %s gets the page', async (role) => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor(role) as never);
    await expect(page()).resolves.toBeTruthy();
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(getSampleKey).toHaveBeenCalledWith('tok', 'a1');
    expect(listMembers).toHaveBeenCalledWith('tok', 'o1');
    expect(listInvites).toHaveBeenCalledWith('tok', 'o1');
    expect(getAppAccess).toHaveBeenCalledWith('tok', 'a1');
  });

  it('an ADMIN gets People with access, Members, Real-value samples and the Danger zone, in that order', async () => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor('ADMIN') as never);
    render(await page());
    const sections = Array.from(document.querySelectorAll('section')).map((s) => s.getAttribute('aria-label'));
    expect(sections).toEqual(['People with access', 'Members', 'Real-value samples', 'Danger zone']);
    expect(screen.getByText('0 of 1 seats used')).toBeTruthy();
  });

  it('only org-wide invites reach Members; app invites show under People with access', async () => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor('ADMIN') as never);
    vi.mocked(listInvites).mockResolvedValue({
      ok: true,
      data: [
        { id: 'i1', email: 'admin@x.co', role: 'ADMIN', appId: null, expiresAt: '2026-10-27T00:00:00Z', createdAt: 'c' },
        { id: 'i2', email: 'app@x.co', role: 'MEMBER', appId: 'a1', expiresAt: '2026-10-27T00:00:00Z', createdAt: 'c' },
      ],
    } as never);
    render(await page());
    const members = document.querySelector('section#members')!;
    expect(members.textContent).toContain('admin@x.co');
    expect(members.textContent).not.toContain('app@x.co');
  });

  it('the free plan offers Member as the only role for an app invite', async () => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor('ADMIN') as never);
    render(await page());
    const people = document.querySelector('section#people') as HTMLElement;
    const options = Array.from(people.querySelectorAll('select option')).map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['MEMBER']);
  });

  it('a 401 from the access list goes through refresh', async () => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor('ADMIN') as never);
    vi.mocked(getAppAccess).mockResolvedValue({ ok: false, status: 401, error: 'unauthorized' } as never);
    await expect(page()).rejects.toThrow(/REDIRECT \/api\/auth\/refresh/);
  });

  it('a failed access list renders as "couldn\'t load", not a broken page', async () => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor('ADMIN') as never);
    vi.mocked(getAppAccess).mockResolvedValue({ ok: false, status: 502, error: 'x' } as never);
    render(await page());
    expect(screen.getByText(/Couldn.t load who has access/)).toBeTruthy();
  });
});
