// @vitest-environment jsdom
// apps/web/components/dashboard/AdviceCard.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { AdviceCard } from './AdviceCard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const advice = { id: 'ad1', signatureId: 's1', suggestion: [{ field: 'email', dir: 1 as const }], rationale: 'Equality first.', status: 'OPEN' as const, updatedAt: '' };

describe('AdviceCard', () => {
  afterEach(cleanup);

  it('shows the createIndex call and rationale', () => {
    render(<AdviceCard appId="a1" model="Order" advice={advice} />);
    expect(screen.getByText('Order.collection.createIndex({ email: 1 })')).toBeTruthy();
    expect(screen.getByText('Equality first.')).toBeTruthy();
  });
  it('asks for confirmation before marking applied (no undo)', () => {
    render(<AdviceCard appId="a1" model="Order" advice={advice} />);
    fireEvent.click(screen.getByRole('button', { name: /mark as applied/i }));
    expect(screen.getByText(/can.t be undone/i)).toBeTruthy();
  });
  it('a settled advice shows its status and no action buttons', () => {
    render(<AdviceCard appId="a1" model="Order" advice={{ ...advice, status: 'DISMISSED' }} />);
    expect(screen.getByText(/dismissed/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /mark as applied/i })).toBeNull();
  });
  it('null advice explains why', () => {
    render(<AdviceCard appId="a1" model="Order" advice={null} />);
    expect(screen.getByText(/No index suggestion/)).toBeTruthy();
  });
  it('a 401 from the PATCH sends the user through /api/auth/refresh back to this page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/dashboard/o/a/queries/s1', search: '?range=7d', assign });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    render(<AdviceCard appId="a1" model="Order" advice={advice} />);
    fireEvent.click(screen.getByRole('button', { name: /mark as applied/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign).toHaveBeenCalledWith('/api/auth/refresh?next=' + encodeURIComponent('/dashboard/o/a/queries/s1?range=7d'));
    vi.unstubAllGlobals();
  });
});
