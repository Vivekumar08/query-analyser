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

const groups = [{ org: { slug: 'o', name: 'Org' }, apps: [{ id: 'a1', name: 'Shop', env: 'prod', href: '/dashboard/o/a1/queries', current: false }] }];
const open = () => {
  render(<AppSwitcher groups={groups as never} currentLabel={{ org: 'Org', app: 'Cur' }} newAppHref="/onboarding" />);
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
    fireEvent.keyDown(item.closest('[cmdk-root]') as HTMLElement, { key: 'Enter' });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/dashboard/o/a1/queries');
  });
});
