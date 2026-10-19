// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/verify',
  useSearchParams: () => new URLSearchParams(),
}));

import LoginPage from '@/app/login/page';
import SignupPage from '@/app/signup/page';
import { VerifyClient } from '@/app/_components/VerifyClient';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';
import { PENDING_INVITE_KEY } from '@/src/pending-invite';
import { installJsdomLocalStorage } from '@/src/jsdom-storage';

installJsdomLocalStorage();

const INVITE = '/invite?token=tOk_en-1';
const store = (value: unknown) => localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify(value));

beforeEach(() => {
  localStorage.clear();
  router.push.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a new invitee keeps the invite through signup', () => {
  it('/login "Create one" carries next to /signup', async () => {
    render(await LoginPage({ searchParams: Promise.resolve({ next: INVITE }) }));
    expect(screen.getByRole('link', { name: 'Create one' }).getAttribute('href'))
      .toBe(`/signup?next=${encodeURIComponent(INVITE)}`);
  });

  it('/login with no next links to plain /signup', async () => {
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('link', { name: 'Create one' }).getAttribute('href')).toBe('/signup');
  });

  it('/login never carries an off-site next', async () => {
    render(await LoginPage({ searchParams: Promise.resolve({ next: '//evil.com' }) }));
    expect(screen.getByRole('link', { name: 'Create one' }).getAttribute('href')).toBe('/signup');
  });

  it('/signup sends the user to next after creating the account', async () => {
    render(await SignupPage({ searchParams: Promise.resolve({ next: INVITE }) }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@x.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'correct horse battery' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form')!);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith(INVITE));
    // ...and "Sign in" keeps it too.
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(`/login?next=${encodeURIComponent(INVITE)}`);
  });

  it('/signup falls back to /dashboard for a missing or off-site next', async () => {
    for (const next of [undefined, '//evil.com', 'https://evil.com/invite?token=x']) {
      cleanup();
      router.push.mockReset();
      render(await SignupPage({ searchParams: Promise.resolve({ next }) }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ana' } });
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@x.test' } });
      fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'correct horse battery' } });
      fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form')!);
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/dashboard'));
    }
  });
});

describe('/verify success', () => {
  it('offers "Continue to your invite" first, the dashboard second, when an invite is pending', async () => {
    store({ path: INVITE, savedAt: Date.now() });
    render(<VerifyClient token="vtok" />);
    const cont = await screen.findByRole('link', { name: 'Continue to your invite' });
    expect(cont.getAttribute('href')).toBe(INVITE);
    const dash = screen.getByRole('link', { name: /dashboard/i });
    // Primary first in reading order.
    expect(cont.compareDocumentPosition(dash) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cont.className).toMatch(/bg-primary/);
    expect(dash.className).not.toMatch(/bg-primary/);
  });

  it('shows only the dashboard link with no pending invite', async () => {
    render(<VerifyClient token="vtok" />);
    await screen.findByRole('link', { name: /dashboard/i });
    expect(screen.queryByRole('link', { name: 'Continue to your invite' })).toBeNull();
  });

  it.each([
    ['expired', { path: INVITE, savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }],
    ['malformed', { path: INVITE }],
    ['off-site', { path: '//evil.com', savedAt: Date.now() }],
    ['off-site invite lookalike', { path: '//evil.com/invite?token=x', savedAt: Date.now() }],
  ])('ignores a %s stored invite', async (_label, value) => {
    store(value);
    render(<VerifyClient token="vtok" />);
    await screen.findByRole('link', { name: /dashboard/i });
    expect(screen.queryByRole('link', { name: 'Continue to your invite' })).toBeNull();
  });
});

describe('onboarding', () => {
  it.each(['verify', 'org'] as const)('on the %s step, offers "Continue to your invite" when one is pending', async (step) => {
    store({ path: INVITE, savedAt: Date.now() });
    render(<OnboardingFlow start={{ step }} email="ana@x.test" />);
    const cont = await screen.findByRole('link', { name: 'Continue to your invite' });
    expect(cont.getAttribute('href')).toBe(INVITE);
  });

  it('says nothing about invites when none is pending', () => {
    render(<OnboardingFlow start={{ step: 'org' }} email="ana@x.test" />);
    expect(screen.queryByRole('link', { name: 'Continue to your invite' })).toBeNull();
  });

  it('ignores an off-site stored path', () => {
    store({ path: '//evil.com', savedAt: Date.now() });
    render(<OnboardingFlow start={{ step: 'org' }} email="ana@x.test" />);
    expect(screen.queryByRole('link', { name: 'Continue to your invite' })).toBeNull();
  });
});
