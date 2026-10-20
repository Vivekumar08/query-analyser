// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { People } from './People';
import type { AppAccessList, Role } from '@/src/dashboard-types';
import { PLAN_LIMIT_COPY } from '@/src/plan-limits';

const list: AppAccessList = {
  people: [
    { userId: 'u-o', name: 'Olu', email: 'o@x.co', role: 'OWNER', allApps: true },
    { userId: 'u-m', name: 'Mo', email: 'm@x.co', role: 'MEMBER', allApps: false },
  ],
  invites: [{ id: 'i1', email: 'n@x.co', role: 'MEMBER', expiresAt: '2026-10-27T00:00:00Z' }],
  seats: { used: 1, max: 1 },
};

let fetchMock: ReturnType<typeof vi.fn>;
const reply = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body ?? {} });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FREE: readonly Role[] = ['MEMBER'];
const PRO: readonly Role[] = ['ADMIN', 'MEMBER', 'VIEWER'];

function renderPeople(invitableRoles: readonly Role[] = FREE, initial: AppAccessList | null = list) {
  return render(<People orgId="org1" appId="app1" invitableRoles={invitableRoles} initial={initial} />);
}

describe('People', () => {
  it('shows the heading, seats, people and pending invites', () => {
    renderPeople();
    expect(screen.getByRole('heading', { name: 'People with access' })).toBeTruthy();
    expect(screen.getByText('1 of 1 seats used')).toBeTruthy();
    const olu = screen.getByText('Olu').closest('li')!;
    expect(within(olu).getByText('All apps')).toBeTruthy();
    expect(within(olu).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove m@x.co’s access' })).toBeTruthy();
    expect(screen.getByText('n@x.co')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke the invite for n@x.co' })).toBeTruthy();
  });

  it('says so when the list could not be loaded', () => {
    renderPeople(FREE, null);
    expect(screen.getByText(/Couldn.t load who has access/)).toBeTruthy();
  });

  it('free: the role select offers Member only, pre-selected', () => {
    renderPeople(FREE);
    const select = screen.getByLabelText('Role') as HTMLSelectElement;
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['MEMBER']);
    expect(select.value).toBe('MEMBER');
  });

  it('pro: the role select offers Member and Viewer, never Admin or Owner', () => {
    renderPeople(PRO);
    const select = screen.getByLabelText('Role') as HTMLSelectElement;
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['MEMBER', 'VIEWER']);
    expect(select.value).toBe('MEMBER');
  });

  it('invites to this app, then reloads the list', async () => {
    const after: AppAccessList = {
      ...list,
      invites: [...list.invites, { id: 'i2', email: 'p@x.co', role: 'MEMBER', expiresAt: '2026-10-27T00:00:00Z' }],
      seats: { used: 2, max: 5 },
    };
    fetchMock
      .mockResolvedValueOnce(reply(201, { id: 'i2', email: 'p@x.co', role: 'MEMBER', expiresAt: 'e', inviteLink: 'https://app.test/invite?token=t1' }))
      .mockResolvedValueOnce(reply(200, after));
    renderPeople(PRO);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' p@x.co ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('p@x.co');
    expect(screen.getByText('https://app.test/invite?token=t1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy the invite link' })).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/orgs/org1/invites');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'p@x.co', role: 'MEMBER', appId: 'app1' });
    await screen.findByText('2 of 5 seats used');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/apps/app1/access');
    expect(screen.getByRole('button', { name: 'Revoke the invite for p@x.co' })).toBeTruthy();
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');
  });

  it('keeps the current list when the reload fails', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(201, { id: 'i2', email: 'p@x.co', role: 'MEMBER', expiresAt: 'e', inviteLink: 'https://app.test/invite?token=t1' }))
      .mockResolvedValueOnce(reply(502, { error: 'x' }));
    renderPeople();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'p@x.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await screen.findByRole('status');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('1 of 1 seats used')).toBeTruthy();
    expect(screen.getByText('n@x.co')).toBeTruthy();
  });

  it('refuses an invalid email without a request', () => {
    renderPeople();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter a valid email address.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the seats copy from the BFF in an alert', async () => {
    fetchMock.mockResolvedValueOnce(reply(403, { error: PLAN_LIMIT_COPY.seats, limit: 'seats' }));
    renderPeople();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'p@x.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect((await screen.findByRole('alert')).textContent).toBe(PLAN_LIMIT_COPY.seats);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('removes access only after confirming, then focuses the heading', async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    renderPeople();
    fireEvent.click(screen.getByRole('button', { name: 'Remove m@x.co’s access' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Remove m@x.co.s access to this app\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove access' }));
    await vi.waitFor(() => expect(screen.queryByText('m@x.co')).toBeNull());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/apps/app1/access/u-m');
    expect(init.method).toBe('DELETE');
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'People with access' })));
  });

  it('cancelling a removal sends nothing and keeps the row', () => {
    renderPeople();
    fireEvent.click(screen.getByRole('button', { name: 'Remove m@x.co’s access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('m@x.co')).toBeTruthy();
  });

  it('shows the BFF error when removal fails and keeps the row', async () => {
    fetchMock.mockResolvedValueOnce(reply(403, { error: 'Only workspace admins can remove access.' }));
    renderPeople();
    fireEvent.click(screen.getByRole('button', { name: 'Remove m@x.co’s access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove access' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Only workspace admins can remove access.');
    expect(screen.getByText('m@x.co')).toBeTruthy();
  });

  it('revokes a pending invite', async () => {
    fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, { ...list, invites: [] }));
    renderPeople();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke the invite for n@x.co' }));
    await vi.waitFor(() => expect(screen.queryByText('n@x.co')).toBeNull());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/orgs/org1/invites/i1');
    expect(init.method).toBe('DELETE');
    expect(document.activeElement?.textContent).toMatch(/Pending invites/);
  });

  it('refreshes the session on a 401', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/dashboard/acme/app1/settings', search: '', assign });
    fetchMock.mockResolvedValueOnce(reply(401));
    renderPeople();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'p@x.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/api/auth/refresh?next=%2Fdashboard%2Facme%2Fapp1%2Fsettings'));
  });
});
