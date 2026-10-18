// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { AcceptInviteClient } from '@/app/_components/AcceptInviteClient';

let fetchMock: ReturnType<typeof vi.fn>;
const reply = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body ?? {} });

beforeEach(() => {
  router.replace.mockReset();
  router.push.mockReset();
  fetchMock = vi.fn().mockResolvedValue(reply(200, { orgId: 'org1', role: 'MEMBER' }));
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/invite?token=tOk_en-1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AcceptInviteClient', () => {
  it('scrubs ?token= with history.replaceState, POSTs it exactly once (StrictMode) and goes to /dashboard', async () => {
    const scrub = vi.spyOn(window.history, 'replaceState');
    render(<StrictMode><AcceptInviteClient /></StrictMode>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));

    expect(scrub).toHaveBeenCalledWith(null, '', '/invite');
    expect(window.location.search).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/invites/accept');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ token: 'tOk_en-1' });
    // The token never shows up in the rendered page.
    expect(document.body.innerHTML).not.toContain('tOk_en-1');
  });

  it.each([
    [410, 'This invite has expired or was already used.'],
    [403, 'This invite was sent to a different email address.'],
    [409, "You're already a member."],
  ])('a %i shows the BFF message in an alert and stays put', async (status, error) => {
    fetchMock.mockResolvedValue(reply(status, { error }));
    render(<AcceptInviteClient />);
    expect((await screen.findByRole('alert')).textContent).toContain(error);
    expect(router.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('a 409 offers a way into the dashboard', async () => {
    fetchMock.mockResolvedValue(reply(409, { error: "You're already a member." }));
    render(<AcceptInviteClient />);
    await screen.findByRole('alert');
    expect(screen.getByRole('link', { name: /dashboard/i }).getAttribute('href')).toBe('/dashboard');
  });

  it('with no token in the URL, says so and sends nothing', async () => {
    window.history.replaceState(null, '', '/invite');
    render(<AcceptInviteClient />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/missing its token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a network failure is reported as such, not as an expired invite', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<AcceptInviteClient />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn.t reach the server/i);
  });

  it('shows a pending status while accepting', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<AcceptInviteClient />);
    expect(screen.getByRole('status').textContent).toMatch(/Joining/);
  });
});
