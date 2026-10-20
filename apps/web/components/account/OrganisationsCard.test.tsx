// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { OrganisationsCard } from './OrganisationsCard';
import { PLAN_LIMIT_COPY } from '@/src/plan-limits';

type Org = { id: string; slug: string; name: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' };
const orgs: Org[] = [
  { id: 'o1', slug: 'acme', name: 'Acme', role: 'OWNER' },
  { id: 'o2', slug: 'team', name: 'Team', role: 'MEMBER' },
];

let fetchMock: ReturnType<typeof vi.fn>;
const reply = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body ?? {} });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  router.refresh.mockReset();
  router.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OrganisationsCard', () => {
  it('lists each org with role and an Open link to its dashboard', () => {
    render(<OrganisationsCard orgs={orgs} canCreateOrg />);
    expect(screen.getByRole('heading', { name: 'Your organisations' })).toBeTruthy();
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByText('Member')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Team' }).getAttribute('href')).toBe('/dashboard/team');
    expect(screen.getByRole('link', { name: 'Open Acme' }).getAttribute('href')).toBe('/dashboard/acme');
    expect(screen.getByRole('link', { name: 'Create organisation' }).getAttribute('href')).toBe('/onboarding?new=org');
  });

  it('leaves only after confirming, removes the row, announces it and keeps focus off <body>', async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    render(<OrganisationsCard orgs={orgs} canCreateOrg />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave Team' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog').textContent).toContain('Leave Team?');
    expect(screen.getByText('You lose access to its apps right away. Someone will need to invite you again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave organisation' }));

    expect((await screen.findByRole('status')).textContent).toBe('You left Team.');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/orgs/o2/membership');
    expect(init.method).toBe('DELETE');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: 'Open Team' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Acme' })).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toMatch(/Your organisations/));
    expect(document.activeElement).not.toBe(document.body);
    expect(router.refresh).toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows the only-owner message on 409 and keeps the row', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { error: "You're the only owner. Make someone else an owner first." }));
    render(<OrganisationsCard orgs={orgs} canCreateOrg />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave Acme' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave organisation' }));

    expect((await screen.findByRole('alert')).textContent).toBe("You're the only owner. Make someone else an owner first.");
    expect(screen.getByRole('link', { name: 'Open Acme' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('Create organisation is disabled with the orgs copy when the limit is reached', () => {
    render(<OrganisationsCard orgs={orgs} canCreateOrg={false} />);
    expect(screen.queryByRole('link', { name: 'Create organisation' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Create organisation' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    const copy = screen.getByText(PLAN_LIMIT_COPY.orgs);
    expect(button.getAttribute('aria-describedby')).toBe(copy.id);
    fireEvent.click(button);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('says so when the last org is gone', async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    render(<OrganisationsCard orgs={[orgs[1]!]} canCreateOrg />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave Team' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave organisation' }));
    expect(await screen.findByText("You're not in any organisation yet.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create organisation' })).toBeTruthy();
  });

  it('disables the row while the leave is in flight, so a double click sends once', async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<OrganisationsCard orgs={orgs} canCreateOrg />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave Team' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave organisation' }));
    const leaveTeam = await screen.findByRole('button', { name: 'Leave Team' });
    await vi.waitFor(() => expect((leaveTeam as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(leaveTeam);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(reply(204));
    await screen.findByRole('status');
  });
});
