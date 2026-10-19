// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/login',
  useSearchParams: () => new URLSearchParams(),
}));

import LoginPage from '@/app/login/page';
import SignupPage from '@/app/signup/page';
import ForgotPasswordPage from '@/app/forgot-password/page';

afterEach(cleanup);

const expectMist = (submit: RegExp) => {
  const button = screen.getByRole('button', { name: submit });
  expect(button.className).toMatch(/rounded-full/);
  expect(button.closest('.glass-strong')).not.toBeNull();
  expect(screen.getByRole('link', { name: /query·analyser/ }).getAttribute('href')).toBe('/');
};

describe('auth screens wear Mist', () => {
  it('login: form on strong glass, pill submit, wordmark home link', async () => {
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expectMist(/sign in/i);
  });

  it('signup', async () => {
    render(await SignupPage({ searchParams: Promise.resolve({}) }));
    expectMist(/create account|sign up/i);
  });

  it('forgot password', () => {
    render(<ForgotPasswordPage />);
    expectMist(/send|reset/i);
  });
});
