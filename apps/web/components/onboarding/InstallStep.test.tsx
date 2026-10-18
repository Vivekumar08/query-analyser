// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { InstallStep } from './InstallStep';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const assign = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ lastSeenAt: null }))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  assign.mockClear();
});

describe('InstallStep', () => {
  it('shows the one-time key notice and the key in the snippet', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey="qa_secret" doneHref="/dashboard/acme/a1/queries" />);
    expect(screen.getByText(/shown once/i)).toBeTruthy();
    expect(screen.getByText(/qa_secret/)).toBeTruthy();
  });
  it('without a key in memory shows "already shown" and no key', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey={null} doneHref="/x" />);
    expect(screen.getByText(/already shown/i)).toBeTruthy();
    expect(screen.queryByText(/qa_/)).toBeNull();
  });
  it('leaving before copying asks for confirmation', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey="qa_secret" doneHref="/x" />);
    fireEvent.click(screen.getByRole('button', { name: /skip|go to/i }));
    expect(screen.getByText(/haven.t copied your key/i)).toBeTruthy();
  });

  it('keyError forbidden shows the admin message and no create button', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey={null} keyError="forbidden" doneHref="/x" />);
    expect(screen.getByText(/only workspace admins/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create a new key/i })).toBeNull();
  });
  it('failed key creation offers a button that shows the new key with the once-notice', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/keys')
        ? new Response(JSON.stringify({ key: 'qa_fresh' }), { status: 201 })
        : new Response(JSON.stringify({ lastSeenAt: null })));
    vi.stubGlobal('fetch', fetchMock);
    render(<InstallStep appId="a1" appName="svc" ingestKey={null} keyError="failed" doneHref="/x" />);
    expect(screen.getByText(/couldn.t create a key/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /create a new key/i }));
    await waitFor(() => expect(screen.getByText(/qa_fresh/)).toBeTruthy());
    expect(screen.getByText(/shown once/i)).toBeTruthy();
  });
  it('401 on the poll with an uncopied key keeps the key visible and defers navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    vi.stubGlobal('location', { ...window.location, pathname: '/onboarding', search: '?org=acme', assign });
    render(<InstallStep appId="a1" appName="svc" ingestKey="qa_secret" doneHref="/x" />);
    await waitFor(() => expect(screen.getByText(/session expired/i)).toBeTruthy());
    expect(screen.getByText(/qa_secret/)).toBeTruthy();
    expect(screen.queryByText(/unauthorized/i)).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(assign).toHaveBeenCalledWith('/api/auth/refresh?next=%2Fonboarding%3Forg%3Dacme');
  });
  it('401 with no key in memory navigates straight to refresh', async () => {
    assign.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    vi.stubGlobal('location', { ...window.location, pathname: '/onboarding', search: '', assign });
    render(<InstallStep appId="a1" appName="svc" ingestKey={null} doneHref="/x" />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/auth/refresh?next=%2Fonboarding'));
  });
});
