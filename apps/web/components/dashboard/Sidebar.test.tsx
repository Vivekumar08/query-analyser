// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/dashboard/acme/a1/queries' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { Sidebar, SidebarAccount, SidebarNav } from './Sidebar';

afterEach(cleanup);

describe('SidebarNav', () => {
  it('Queries and Settings are links; the other C2 pages are disabled with a Soon badge', () => {
    render(<SidebarNav base="/dashboard/acme/a1" />);
    expect(screen.getByRole('link', { name: /queries/i }).getAttribute('href')).toBe('/dashboard/acme/a1/queries');
    expect(screen.getByRole('link', { name: /settings/i }).getAttribute('href')).toBe('/dashboard/acme/a1/settings');
    for (const name of ['Overview', 'Alerts']) {
      expect(screen.queryByRole('link', { name: new RegExp(name, 'i') })).toBeNull();
      expect(screen.getByText(name).closest('[aria-disabled="true"]')).toBeTruthy();
    }
    expect(screen.getAllByText('Soon')).toHaveLength(2);
  });

  it('marks the current page', () => {
    nav.pathname = '/dashboard/acme/a1/queries/h1';
    const { rerender } = render(<SidebarNav base="/dashboard/acme/a1" />);
    expect(screen.getByRole('link', { name: /queries/i }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: /settings/i }).getAttribute('aria-current')).toBeNull();
    nav.pathname = '/dashboard/acme/a1/settings';
    rerender(<SidebarNav base="/dashboard/acme/a1" />);
    expect(screen.getByRole('link', { name: /settings/i }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: /queries/i }).getAttribute('aria-current')).toBeNull();
  });
});

describe('Sidebar', () => {
  it('sidebar is pinned', () => {
    const { container } = render(
      <Sidebar
        switcher={<span>switch</span>}
        nav={<SidebarNav base="/dashboard/acme/a1" />}
        footer={<span>foot</span>}
      />,
    );
    const aside = container.querySelector('aside');
    expect(aside).toBeTruthy();
    const classes = aside!.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['sticky', 'top-0', 'h-dvh']));
    const navWrapper = aside!.querySelector('nav')!.parentElement!;
    expect(navWrapper.className.split(/\s+/)).toContain('overflow-y-auto');
  });
});

describe('SidebarAccount', () => {
  it('links the name and email to the account page', () => {
    render(<SidebarAccount name="Ada" email="ada@x.io" />);
    const link = screen.getByRole('link', { name: /Ada/ });
    expect(link.getAttribute('href')).toBe('/dashboard/account');
    expect(link.textContent).toContain('ada@x.io');
  });
});
