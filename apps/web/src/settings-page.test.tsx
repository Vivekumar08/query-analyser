// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
  notFound: vi.fn(() => { throw new Error('NOT_FOUND'); }),
}));
vi.mock('next/navigation', () => ({
  redirect: nav.redirect,
  notFound: nav.notFound,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/src/shell-context', () => ({ getShellContext: vi.fn() }));
vi.mock('@/src/dashboard-api', () => ({ getSampleKey: vi.fn(), listInvites: vi.fn(), listMembers: vi.fn() }));

import SettingsPage from '@/app/dashboard/[org]/[app]/settings/page';
import { getShellContext } from '@/src/shell-context';
import { getSampleKey, listInvites, listMembers } from '@/src/dashboard-api';
import type { Role } from '@/src/dashboard-types';

const ctxFor = (role: Role) => ({
  session: { accessToken: 'tok', user: { id: 'u1' } },
  currentOrg: { id: 'o1', slug: 'acme', name: 'Acme', role },
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
});
afterEach(cleanup);

describe('/dashboard/[org]/[app]/settings', () => {
  it.each(['MEMBER', 'VIEWER'] as const)('a %s gets the not-found page and no settings data is fetched', async (role) => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor(role) as never);
    await expect(page()).rejects.toThrow('NOT_FOUND');
    expect(getSampleKey).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
    expect(listInvites).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'OWNER'] as const)('an %s gets the page', async (role) => {
    vi.mocked(getShellContext).mockResolvedValue(ctxFor(role) as never);
    await expect(page()).resolves.toBeTruthy();
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(getSampleKey).toHaveBeenCalledWith('tok', 'a1');
    expect(listMembers).toHaveBeenCalledWith('tok', 'o1');
  });
});
