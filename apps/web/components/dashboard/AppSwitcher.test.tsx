// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
// A plain anchor: Link's own navigation is not under test, only what surrounds it.
vi.mock('next/link', () => ({
  default: ({ href, onClick, children, className }: { href: string; onClick?: (e: React.MouseEvent) => void; children: React.ReactNode; className?: string }) => (
    <a href={href} onClick={(e) => { onClick?.(e); e.preventDefault(); }} className={className}>{children}</a>
  ),
}));
// jsdom lacks these; cmdk needs them.
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
Element.prototype.scrollIntoView = () => {};
import { AppSwitcher } from './AppSwitcher';
import { PLAN_LIMIT_COPY } from '@/src/plan-limits';

const groups = [{ org: { slug: 'o', name: 'Org' }, apps: [{ id: 'a1', name: 'Shop', env: 'prod', href: '/dashboard/o/a1/queries', current: false }] }];
const orgs = [
  { slug: 'o', name: 'Org', role: 'OWNER' as const, href: '/dashboard/o', current: true },
  { slug: 't', name: 'Team', role: 'MEMBER' as const, href: '/dashboard/t', current: false },
];
type NewApp = { href: string; blocked: string | null } | null;
const open = (newApp: NewApp = { href: '/onboarding?org=o', blocked: null }, newOrgBlocked: string | null = null) => {
  render(<AppSwitcher groups={groups as never} orgs={orgs} currentLabel={{ org: 'Org', app: 'Cur' }} newApp={newApp} newOrgBlocked={newOrgBlocked} />);
  fireEvent.click(screen.getByRole('button'));
};

describe('AppSwitcher', () => {
  afterEach(() => { cleanup(); push.mockClear(); });

  it('items are real anchors', () => {
    open();
    expect(screen.getByText('Shop').closest('a')?.getAttribute('href')).toBe('/dashboard/o/a1/queries');
  });
  it('a plain click does not trigger cmdk onSelect navigation (the Link handles it)', () => {
    open();
    fireEvent.click(screen.getByText('Shop'));
    expect(push).not.toHaveBeenCalled();
  });
  it('keyboard Enter navigates exactly once via router.push', () => {
    open();
    const item = screen.getByText('Shop').closest('[cmdk-item]') as HTMLElement;
    const root = item.closest('[cmdk-root]') as HTMLElement;
    // The two organisations come first; arrow past them to the app.
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(item.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/dashboard/o/a1/queries');
  });
  it('lists organisations with the role and marks the current one', () => {
    open();
    const team = screen.getByText('Team').closest('a')!;
    expect(team.getAttribute('href')).toBe('/dashboard/t');
    expect(team.textContent).toContain('Member');
    const marks = screen.getAllByLabelText('current organisation');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest('a')?.getAttribute('href')).toBe('/dashboard/o');
  });
  it('organisations are reachable by keyboard', () => {
    open();
    const root = screen.getByText('Team').closest('[cmdk-root]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/dashboard/t');
  });
  it('offers New organisation and Account to everyone', () => {
    open(null);
    expect(screen.getByText('New organisation').closest('a')?.getAttribute('href')).toBe('/onboarding?new=org');
    expect(screen.getByText('Account').closest('a')?.getAttribute('href')).toBe('/dashboard/account');
  });
  it('hides New app when the role cannot create apps', () => {
    open(null);
    expect(screen.queryByText('New app')).toBeNull();
  });
  it('shows New app for admins', () => {
    open();
    expect(screen.getByText('New app').closest('a')?.getAttribute('href')).toBe('/onboarding?org=o');
  });
  it('a blocked New app stays visible, disabled, with the apps copy and no link', () => {
    open({ href: '/onboarding?org=o', blocked: PLAN_LIMIT_COPY.apps });
    expect(screen.getByText('New app').closest('a')).toBeNull();
    const item = screen.getByText('New app').closest('[aria-disabled="true"]') as HTMLElement;
    expect(item).toBeTruthy();
    const copy = screen.getByText(PLAN_LIMIT_COPY.apps);
    expect(item.contains(copy)).toBe(true);
    // The copy is the item's description, not only nearby text.
    expect(item.getAttribute('aria-describedby')).toBe(copy.id);
    fireEvent.click(screen.getByText('New app'));
    expect(push).not.toHaveBeenCalled();
  });
  it('a blocked New organisation likewise shows the orgs copy and never navigates', () => {
    open(null, PLAN_LIMIT_COPY.orgs);
    expect(screen.getByText('New organisation').closest('a')).toBeNull();
    const item = screen.getByText('New organisation').closest('[aria-disabled="true"]') as HTMLElement;
    expect(item).toBeTruthy();
    const copy = screen.getByText(PLAN_LIMIT_COPY.orgs);
    expect(item.getAttribute('aria-describedby')).toBe(copy.id);
    // Account still works.
    expect(screen.getByText('Account').closest('a')?.getAttribute('href')).toBe('/dashboard/account');
    // Keyboard selection never lands on it, so Enter can't navigate there.
    const root = item.closest('[cmdk-root]') as HTMLElement;
    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(root, { key: 'ArrowDown' });
      expect(item.getAttribute('aria-selected')).toBe('false');
    }
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(push).not.toHaveBeenCalledWith('/onboarding?new=org');
  });
  it('an unblocked New organisation has no limit copy', () => {
    open();
    expect(screen.queryByText(PLAN_LIMIT_COPY.orgs)).toBeNull();
    expect(screen.queryByText(PLAN_LIMIT_COPY.apps)).toBeNull();
  });
});
