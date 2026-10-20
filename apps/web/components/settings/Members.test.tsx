// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { Members } from './Members';
import type { Member, PendingInvite, Role } from '@/src/dashboard-types';
import { PLAN_LIMIT_COPY } from '@/src/plan-limits';

const me: Member = { id: 'm-me', role: 'OWNER', createdAt: 'c', user: { id: 'u-me', email: 'me@x.co', name: 'Me' }, allApps: true, apps: [] };
const ada: Member = { id: 'm-ada', role: 'MEMBER', createdAt: 'c', user: { id: 'u-ada', email: 'ada@x.co', name: 'Ada' }, allApps: false, apps: [{ id: 'a1', name: 'Shop', role: 'MEMBER' }] };
const invite: PendingInvite = { id: 'i1', email: 'new@x.co', role: 'ADMIN', appId: null, expiresAt: '2026-10-26T00:00:00Z', createdAt: 'c' };

const FREE: readonly Role[] = ['MEMBER'];
const PRO: readonly Role[] = ['ADMIN', 'MEMBER', 'VIEWER'];

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

function renderAs(role: 'OWNER' | 'ADMIN', viewerUserId = 'u-me', invitableRoles: readonly Role[] = PRO) {
  return render(
    <Members orgId="org1" viewerRole={role} viewerUserId={viewerUserId} invitableRoles={invitableRoles} initialMembers={[me, ada]} initialInvites={[invite]} />,
  );
}

describe('Members (ADMIN)', () => {
  it('sees members, the pending list and Revoke — but no role change or Remove', () => {
    renderAs('ADMIN', 'u-other');
    expect(screen.getByText('ada@x.co')).toBeTruthy();
    expect(screen.getByText('new@x.co')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke the invite for new@x.co' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(screen.queryByLabelText(/Role for/)).toBeNull();
  });

  it("shows each member's apps", () => {
    renderAs('ADMIN', 'u-other');
    expect(within(screen.getByText('ada@x.co').closest('li')!).getByText('Member · Shop')).toBeTruthy();
    expect(within(screen.getByText('me@x.co').closest('li')!).getByText('All apps')).toBeTruthy();
  });

  it('has no per-app invite form; on free there is no admin invite either', () => {
    renderAs('ADMIN', 'u-other', FREE);
    expect(screen.queryByRole('button', { name: 'Send invite' })).toBeNull();
    expect(screen.queryByLabelText('Role')).toBeNull();
    expect(screen.queryByText('Invite an admin')).toBeNull();
    // The pending list stays.
    expect(screen.getByText('new@x.co')).toBeTruthy();
  });

  it('on pro, invites an admin org-wide, then shows the copyable link and the new pending invite', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(201, { id: 'i2', email: 'bo@x.co', role: 'ADMIN', expiresAt: 'e', inviteLink: 'https://app.test/invite?token=t1' }))
      .mockResolvedValueOnce(reply(200, [
        { id: 'i2', email: 'bo@x.co', role: 'ADMIN', appId: null, expiresAt: 'e', createdAt: 'c' },
        { id: 'i3', email: 'app@x.co', role: 'MEMBER', appId: 'a1', expiresAt: 'e', createdAt: 'c' },
        invite,
      ]));
    renderAs('ADMIN', 'u-other', PRO);
    expect(screen.getByText('Invite an admin')).toBeTruthy();
    expect(screen.queryByLabelText('Role')).toBeNull();
    fireEvent.change(screen.getByLabelText('Admin email'), { target: { value: 'bo@x.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('bo@x.co');
    expect(screen.getByText('https://app.test/invite?token=t1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy the invite link' })).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/orgs/org1/invites');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'bo@x.co', role: 'ADMIN' });
    await screen.findByRole('button', { name: 'Revoke the invite for bo@x.co' });
    // App invites belong to People with access, not here.
    expect(screen.queryByText('app@x.co')).toBeNull();
  });

  it.each([
    [429, 'Too many invites — try again in a minute.'],
    [403, PLAN_LIMIT_COPY.role],
    [403, PLAN_LIMIT_COPY.seats],
  ])('shows the BFF message for a %i', async (code, message) => {
    fetchMock.mockResolvedValueOnce(reply(code, { error: message }));
    renderAs('ADMIN', 'u-other', PRO);
    fireEvent.change(screen.getByLabelText('Admin email'), { target: { value: 'bo@x.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });

  it('Revoke DELETEs the invite, drops the row and keeps focus off <body>', async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    renderAs('ADMIN', 'u-other');
    const revoke = screen.getByRole('button', { name: 'Revoke the invite for new@x.co' });
    revoke.focus();
    fireEvent.click(revoke);
    await vi.waitFor(() => expect(screen.queryByText('new@x.co')).toBeNull());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/orgs/org1/invites/i1');
    expect(fetchMock.mock.calls[0]![1].method).toBe('DELETE');
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toMatch(/Pending invites/);
  });
});

describe('Members (OWNER)', () => {
  it('free: the role select offers Owner and Member only', () => {
    renderAs('OWNER', 'u-me', FREE);
    const options = within(screen.getByLabelText('Role for ada@x.co')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Owner', 'Member']);
  });

  it("keeps a member's current role in the select even when the plan can't invite it", () => {
    const viewer: Member = { ...ada, id: 'm-v', role: 'VIEWER', user: { id: 'u-v', email: 'v@x.co', name: 'V' } };
    render(<Members orgId="org1" viewerRole="OWNER" viewerUserId="u-me" invitableRoles={FREE} initialMembers={[me, viewer]} initialInvites={[]} />);
    const select = screen.getByLabelText('Role for v@x.co') as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Owner', 'Member', 'Viewer']);
    expect(select.value).toBe('VIEWER');
  });

  it('pro: the role select offers every role', () => {
    renderAs('OWNER', 'u-me', PRO);
    const options = within(screen.getByLabelText('Role for ada@x.co')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Owner', 'Admin', 'Member', 'Viewer']);
  });

  it('changes a role only after confirming', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: 'm-ada', role: 'ADMIN' }));
    renderAs('OWNER');
    fireEvent.change(screen.getByLabelText('Role for ada@x.co'), { target: { value: 'ADMIN' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Change ada@x.co.s role to Admin\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/orgs/org1/members/m-ada');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ role: 'ADMIN' });
    await vi.waitFor(() => expect((screen.getByLabelText('Role for ada@x.co') as HTMLSelectElement).value).toBe('ADMIN'));
    // Promoted to org-wide: her app list becomes every app.
    expect(within(screen.getByText('ada@x.co').closest('li')!).getByText('All apps')).toBeTruthy();
  });

  it("a MEMBER made VIEWER keeps her apps, now as Viewer", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: 'm-ada', role: 'VIEWER' }));
    renderAs('OWNER');
    fireEvent.change(screen.getByLabelText('Role for ada@x.co'), { target: { value: 'VIEWER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await vi.waitFor(() => expect(within(screen.getByText('ada@x.co').closest('li')!).getByText('Viewer · Shop')).toBeTruthy());
  });

  it('cancelling a role change leaves the select unchanged and sends nothing', () => {
    renderAs('OWNER');
    fireEvent.change(screen.getByLabelText('Role for ada@x.co'), { target: { value: 'ADMIN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((screen.getByLabelText('Role for ada@x.co') as HTMLSelectElement).value).toBe('MEMBER');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes a member only after confirming, and moves focus to the list', async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    renderAs('OWNER');
    fireEvent.click(screen.getByRole('button', { name: 'Remove ada@x.co' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Remove ada@x.co from this workspace\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    await vi.waitFor(() => expect(screen.queryByText('ada@x.co')).toBeNull());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/orgs/org1/members/m-ada');
    expect(init.method).toBe('DELETE');
    await vi.waitFor(() => expect(document.activeElement?.textContent).toMatch(/^\s*Members$/));
  });

  it('cannot remove or re-role themselves', () => {
    renderAs('OWNER');
    expect(screen.queryByRole('button', { name: 'Remove me@x.co' })).toBeNull();
    expect(screen.queryByLabelText('Role for me@x.co')).toBeNull();
  });

  it('surfaces the last-owner error from the API', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { error: 'A workspace must keep at least one owner.' }));
    renderAs('OWNER');
    fireEvent.click(screen.getByRole('button', { name: 'Remove ada@x.co' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A workspace must keep at least one owner.');
    expect(screen.getByText('ada@x.co')).toBeTruthy();
  });
});
