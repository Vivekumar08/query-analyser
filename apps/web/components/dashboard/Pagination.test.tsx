// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Pagination } from './Pagination';

const hrefFor = (p: number) => `/q?page=${p}`;

describe('Pagination', () => {
  afterEach(cleanup);

  it('page 1 disables Previous (not a link) and links Next from hrefFor', () => {
    render(<Pagination page={1} hasMore hrefFor={hrefFor} />);
    const prev = screen.getByText('Previous').closest('[aria-disabled]')!;
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('link', { name: /previous/i })).toBeNull();
    expect(screen.getByRole('link', { name: /next/i }).getAttribute('href')).toBe('/q?page=2');
    expect(screen.getByText('Page 1')).toBeTruthy();
  });

  it('hasMore=false disables Next; Previous links back', () => {
    render(<Pagination page={3} hasMore={false} hrefFor={hrefFor} />);
    expect(screen.queryByRole('link', { name: /next/i })).toBeNull();
    expect(screen.getByText('Next').closest('[aria-disabled]')!.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('link', { name: /previous/i }).getAttribute('href')).toBe('/q?page=2');
    expect(screen.getByText('Page 3')).toBeTruthy();
  });
});
