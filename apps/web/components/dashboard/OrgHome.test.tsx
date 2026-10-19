// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { OrgHome } from './OrgHome';

afterEach(cleanup);

describe('OrgHome', () => {
  it.each(['MEMBER', 'VIEWER'] as const)('a %s sees the ask-an-admin empty state and a way to their own org', (role) => {
    render(<OrgHome org={{ slug: 'team', name: 'Team', role }} orgs={[{ slug: 'team', name: 'Team', role }]} suspended={false} />);
    expect(screen.getByText('No apps yet. Ask an admin to connect one.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create your own organisation' }).getAttribute('href')).toBe('/onboarding?new=org');
    expect(screen.queryByRole('link', { name: 'Connect your first app' })).toBeNull();
  });

  it.each(['ADMIN', 'OWNER'] as const)('an %s is offered "Connect your first app" in this org', (role) => {
    render(<OrgHome org={{ slug: 'my org', name: 'Mine', role }} orgs={[{ slug: 'my org', name: 'Mine', role }]} suspended={false} />);
    expect(screen.getByRole('link', { name: 'Connect your first app' }).getAttribute('href')).toBe('/onboarding?org=my%20org');
    expect(screen.queryByText('No apps yet. Ask an admin to connect one.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create your own organisation' })).toBeNull();
  });

  it('shows the org name and role, links every org to /dashboard/<slug>, and offers Account and Sign out', () => {
    render(
      <OrgHome
        org={{ slug: 'team', name: 'Team', role: 'MEMBER' }}
        orgs={[{ slug: 'team', name: 'Team', role: 'MEMBER' }, { slug: 'other', name: 'Other', role: 'OWNER' }]}
        suspended={false}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Team' })).toBeTruthy();
    expect(screen.getAllByText('Member').length).toBeGreaterThan(0);
    const nav = screen.getByRole('navigation', { name: 'Organisations' });
    const other = screen.getByRole('link', { name: /Other/ });
    expect(nav.contains(other)).toBe(true);
    expect(other.getAttribute('href')).toBe('/dashboard/other');
    expect(other.getAttribute('aria-current')).toBeNull();
    const current = screen.getByRole('link', { name: /^Team/ });
    expect(current.getAttribute('href')).toBe('/dashboard/team');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/dashboard/account');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('encodes slugs in org links', () => {
    render(<OrgHome org={{ slug: 'a b', name: 'AB', role: 'OWNER' }} orgs={[{ slug: 'a b', name: 'AB', role: 'OWNER' }]} suspended={false} />);
    expect(screen.getByRole('link', { name: /^AB/ }).getAttribute('href')).toBe('/dashboard/a%20b');
  });

  it('a suspended org says so and offers no setup (Review Focus)', () => {
    render(<OrgHome org={{ slug: 'team', name: 'Team', role: 'OWNER' }} orgs={[{ slug: 'team', name: 'Team', role: 'OWNER' }]} suspended />);
    expect(screen.getByText('This organisation is suspended.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Connect your first app' })).toBeNull();
    expect(screen.queryByText('No apps yet. Ask an admin to connect one.')).toBeNull();
  });
});
