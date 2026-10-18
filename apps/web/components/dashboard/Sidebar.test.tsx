// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SidebarNav } from './Sidebar';

afterEach(cleanup);

describe('SidebarNav', () => {
  it('Queries is a link; C2 pages are disabled with a Soon badge', () => {
    render(<SidebarNav base="/dashboard/acme/a1" active="queries" />);
    expect(screen.getByRole('link', { name: /queries/i }).getAttribute('href')).toBe('/dashboard/acme/a1/queries');
    for (const name of ['Overview', 'Alerts', 'Settings']) {
      expect(screen.queryByRole('link', { name: new RegExp(name, 'i') })).toBeNull();
      expect(screen.getByText(name).closest('[aria-disabled="true"]')).toBeTruthy();
    }
    expect(screen.getAllByText('Soon')).toHaveLength(3);
  });
});
