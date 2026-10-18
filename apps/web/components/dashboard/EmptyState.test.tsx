// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueriesEmpty } from './EmptyState';

afterEach(cleanup);

describe('QueriesEmpty', () => {
  it('no-data explains what to do next', () => {
    render(<QueriesEmpty kind="no-data" clearHref="/x" installHref="https://example.com/install" />);
    expect(screen.getByText(/No queries ≥ 100ms in this window/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /install instructions/i }).getAttribute('href')).toBe('https://example.com/install');
  });
  it('no-match offers clearing filters', () => {
    render(<QueriesEmpty kind="no-match" clearHref="/dashboard/acme/a1/queries" installHref="https://example.com/install" />);
    expect(screen.getByRole('link', { name: /clear filters/i }).getAttribute('href')).toBe('/dashboard/acme/a1/queries');
  });
});
