// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
}));
vi.mock('next/navigation', () => ({
  redirect: nav.redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/src/auth', () => ({ requireSession: vi.fn() }));
vi.mock('@/src/dashboard-api', () => ({ listOrgs: vi.fn() }));

import AccountPage from '@/app/dashboard/account/page';
import { requireSession } from '@/src/auth';
import { listOrgs } from '@/src/dashboard-api';

const USER = { id: 'u1', email: 'ada@x.co', name: 'Ada', isPlatformAdmin: false, emailVerifiedAt: 'v' };
const ORGS = [{ id: 'o1', slug: 'team', name: 'Team', plan: 'free', createdAt: 'c', role: 'MEMBER' }];

beforeEach(() => {
  nav.redirect.mockClear();
  vi.mocked(requireSession).mockReset().mockResolvedValue({ accessToken: 'tok', user: USER } as never);
  vi.mocked(listOrgs).mockReset().mockResolvedValue({ ok: true, data: ORGS } as never);
});
afterEach(cleanup);

describe('/dashboard/account', () => {
  it('renders the three cards in the bare shell with a back link', async () => {
    render(await AccountPage());
    expect(vi.mocked(requireSession).mock.calls[0]).toEqual(['/dashboard/account']);
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '← Back to dashboard' }).getAttribute('href')).toBe('/dashboard');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Ada');
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.getByText('Other devices are signed out within 15 minutes.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Team' }).getAttribute('href')).toBe('/dashboard/team');
    expect(vi.mocked(listOrgs).mock.calls[0]).toEqual(['tok']);
  });

  it('sends an unverified user to /onboarding', async () => {
    vi.mocked(requireSession).mockResolvedValue({ accessToken: 'tok', user: { ...USER, emailVerifiedAt: null } } as never);
    await expect(AccountPage()).rejects.toThrow('REDIRECT /onboarding');
    expect(listOrgs).not.toHaveBeenCalled();
  });

  it('refreshes the session when the org list 401s', async () => {
    vi.mocked(listOrgs).mockResolvedValue({ ok: false, status: 401, error: 'x' } as never);
    await expect(AccountPage()).rejects.toThrow('REDIRECT /api/auth/refresh?next=%2Fdashboard%2Faccount');
  });

  it('throws on any other org list failure', async () => {
    vi.mocked(listOrgs).mockResolvedValue({ ok: false, status: 500, error: 'x' } as never);
    await expect(AccountPage()).rejects.toThrow(/Could not load/);
  });
});
