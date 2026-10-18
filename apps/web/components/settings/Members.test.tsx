// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { Members } from './Members';
import type { Member, PendingInvite } from '@/src/dashboard-types';

const me: Member = { id: 'm-me', role: 'OWNER', createdAt: 'c', user: { id: 'u-me', email: 'me@x.co', name: 'Me' } };
const ada: Member = { id: 'm-ada', role: 'MEMBER', createdAt: 'c', user: { id: 'u-ada', email: 'ada@x.co', name: 'Ada' } };
const invite: PendingInvite = { id: 'i1', email: 'new@x.co', role: 'VIEWER', expiresAt: '2026-10-26T00:00:00Z', createdAt: 'c' };

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

function renderAs(role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER', viewerUserId = 'u-me') {
  const members = role === 'OWNER' || role === 'ADMIN' ? [me, ada] : null;
  const invites = role === 'OWNER' || role === 'ADMIN' ? [invite] : null;
  return render(<Members orgId="org1" viewerRole={role} viewerUserId={viewerUserId} initialMembers={members} initialInvites={invites} />);
}

describe('Members (MEMBER / VIEWER)', () => {
  it('sees "Ask an admin to invite teammates." and no controls', () => {
    renderAs('MEMBER');
    expect(screen.getByText('Ask an admin to invite teammates.')).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('Members (ADMIN)', () => {
  it('sees members, the invite form, the pending list and Revoke — but no role change or Remove', () => {
    renderAs('ADMIN', 'u-other');
    expect(screen.getByText('ada@x.co')).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Role')).toBeTruthy();
    expect(screen.getByText('new@x.co')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke the invite for new@x.co' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(screen.queryByLabelText(/Role for/)).toBeNull();
  });

  it('cannot pick OWNER in the invite role select', () => {
    renderAs('ADMIN', 'u-other');
    const options = within(screen.getByLabelText('Role')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain('OWNER');
  });

  it('invites by email + role, then shows the copyable link as a fallback and the new pending invite', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(201, { id: 'i2', email: 'bo@x.co', role: 'MEMBER', expiresAt: 'e', inviteLink: 'https://app.test/invite?token=t1' }))
      .mockResolvedValueOnce(reply(200, [{ id: 'i2', email: 'bo@x.co', role: 'MEMBER', expiresAt: 'e', createdAt: 'c' }, invite]));
    renderAs('ADMIN', 'u-other');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bo@x.co' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'MEMBER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('bo@x.co');
    expect(screen.getByText('https://app.test/invite?token=t1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy the invite link' })).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/orgs/org1/invites');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'bo@x.co', role: 'MEMBER' });
    await screen.findByRole('button', { name: 'Revoke the invite for bo@x.co' });
  });

  it.each([
    [429, 'Too many invites — try again in a minute.'],
    [409, 'Too many pending invites — revoke some first.'],
    [403, 'Only an owner can invite another owner.'],
  ])('shows the BFF message for a %i', async (code, message) => {
    fetchMock.mockResolvedValueOnce(reply(code, { error: message }));
    renderAs('ADMIN', 'u-other');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bo@x.co' } });
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
  it('can invite an OWNER', () => {
    renderAs('OWNER');
    const options = within(screen.getByLabelText('Role')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('OWNER');
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
