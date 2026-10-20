// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { AcceptInviteClient } from '@/app/_components/AcceptInviteClient';
import { PENDING_INVITE_KEY } from '@/src/pending-invite';
import { installJsdomLocalStorage } from '@/src/jsdom-storage';

installJsdomLocalStorage();

let fetchMock: ReturnType<typeof vi.fn>;
const reply = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body ?? {} });

beforeEach(() => {
  router.replace.mockReset();
  router.push.mockReset();
  fetchMock = vi.fn().mockResolvedValue(reply(200, { orgId: 'org1', slug: 'acme', role: 'MEMBER' }));
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/invite?token=tOk_en-1');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AcceptInviteClient', () => {
  it('scrubs ?token= with history.replaceState, POSTs it exactly once (StrictMode) and goes to the team at /dashboard/<slug>', async () => {
    const scrub = vi.spyOn(window.history, 'replaceState');
    render(<StrictMode><AcceptInviteClient /></StrictMode>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/acme'));

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
    [403, 'During the beta, teammates join as Members.'],
  ])('a %i shows the BFF message in an alert and stays put', async (status, error) => {
    fetchMock.mockResolvedValue(reply(status, { error }));
    render(<AcceptInviteClient />);
    expect((await screen.findByRole('alert')).textContent).toContain(error);
    expect(router.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('falls back to /dashboard when the response has no slug', async () => {
    fetchMock.mockResolvedValue(reply(200, { orgId: 'org1' }));
    render(<AcceptInviteClient />);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('falls back to /dashboard when the 200 body is not JSON', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
    render(<AcceptInviteClient />);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('lands on the app the invite was for when the reply names one', async () => {
    fetchMock.mockResolvedValue(reply(200, { orgId: 'org1', slug: 'acme', appId: 'a1' }));
    render(<AcceptInviteClient />);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/acme/a1/queries'));
  });

  it('without a usable appId it stays on /dashboard/<slug>', async () => {
    for (const appId of [undefined, '', '..', 'a/b', 7]) {
      cleanup();
      router.replace.mockReset();
      window.history.replaceState(null, '', '/invite?token=tOk_en-1');
      fetchMock.mockResolvedValue(reply(200, { orgId: 'org1', slug: 'acme', appId }));
      render(<AcceptInviteClient />);
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/acme'));
    }
  });

  it('an unusable slug falls back to /dashboard, even with an appId', async () => {
    for (const slug of ['.', '..']) {
      cleanup();
      router.replace.mockReset();
      window.history.replaceState(null, '', '/invite?token=tOk_en-1');
      fetchMock.mockResolvedValue(reply(200, { orgId: 'org1', slug, appId: 'a1' }));
      render(<AcceptInviteClient />);
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));
    }
  });

  it('encodes the slug in the redirect', async () => {
    fetchMock.mockResolvedValue(reply(200, { orgId: 'org1', slug: 'a b' }));
    render(<AcceptInviteClient />);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/a%20b'));
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

  describe('pending invite (survives signup and the verify-email hop)', () => {
    const stored = () => {
      const raw = localStorage.getItem(PENDING_INVITE_KEY);
      return raw === null ? null : (JSON.parse(raw) as { path: string; savedAt: number });
    };

    it('is saved before the URL is scrubbed', () => {
      fetchMock.mockReturnValue(new Promise(() => {}));
      let atScrub: ReturnType<typeof stored> = null;
      vi.spyOn(window.history, 'replaceState').mockImplementation(() => { atScrub = stored(); });
      render(<AcceptInviteClient />);
      expect(atScrub).toMatchObject({ path: '/invite?token=tOk_en-1' });
      expect(typeof atScrub!.savedAt).toBe('number');
    });

    it('is cleared once the invite is accepted', async () => {
      render(<AcceptInviteClient />);
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/acme'));
      expect(stored()).toBeNull();
    });

    it.each([
      [410, 'This invite has expired or was already used.', undefined],
      [404, 'This invite has expired or was already used.', undefined],
      [403, 'This invite was sent to a different email address.', undefined],
      [409, "You're already a member.", undefined],
    ])('is cleared on a terminal %i', async (status, error, code) => {
      fetchMock.mockResolvedValue(reply(status, { error, code }));
      render(<AcceptInviteClient />);
      await screen.findByRole('alert');
      expect(stored()).toBeNull();
    });

    it('is kept when the email is not verified yet, so /verify can lead back here', async () => {
      fetchMock.mockResolvedValue(reply(403, { error: 'Confirm your email address first, then open the invite link again.', code: 'email_not_verified' }));
      render(<AcceptInviteClient />);
      await screen.findByRole('alert');
      expect(stored()).toMatchObject({ path: '/invite?token=tOk_en-1' });
    });

    it('is kept on a network failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      render(<AcceptInviteClient />);
      await screen.findByRole('alert');
      expect(stored()).toMatchObject({ path: '/invite?token=tOk_en-1' });
    });

    it('a broken localStorage does not stop the accept', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
      render(<AcceptInviteClient />);
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/acme'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
