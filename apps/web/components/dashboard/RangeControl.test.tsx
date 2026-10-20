// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/dashboard/o/a/queries',
  useSearchParams: () => new URLSearchParams(),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

import { RangeControl } from './RangeControl';

afterEach(() => {
  cleanup();
  replace.mockClear();
  vi.useRealTimers();
});

describe('RangeControl', () => {
  it('disables presets longer than the plan keeps and says why', () => {
    render(<RangeControl value={{ kind: 'preset', preset: '24h' }} retentionDays={7} />);
    const long = screen.getByRole('radio', { name: '30d' }) as HTMLButtonElement;
    expect(long.disabled).toBe(true);
    expect(long.getAttribute('title')).toBe('Kept for 7 days on your plan');
    expect((screen.getByRole('radio', { name: '7d' }) as HTMLButtonElement).disabled).toBe(false);
    const note = screen.getByText('Kept for 7 days on your plan');
    expect(note.className).toContain('text-xs');
    fireEvent.click(long);
    expect(replace).not.toHaveBeenCalled();
  });

  it('enables every preset and shows no note when the plan keeps them all', () => {
    render(<RangeControl value={{ kind: 'preset', preset: '24h' }} retentionDays={30} />);
    for (const p of ['1h', '24h', '7d', '30d']) {
      expect((screen.getByRole('radio', { name: p }) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(screen.queryByText(/Kept for/)).toBeNull();
  });

  it('the calendar disables days the plan no longer keeps', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 18, 12));
    render(<RangeControl value={{ kind: 'preset', preset: '24h' }} retentionDays={7} />);
    fireEvent.click(screen.getByRole('button', { name: /Custom/ }));
    const dayButton = (d: number) => document.querySelector(`[data-day="${new Date(2026, 9, d).toLocaleDateString()}"]`) as HTMLButtonElement;
    expect(dayButton(10).disabled).toBe(true);
    expect(dayButton(12).disabled).toBe(false);
    // Future days stay disabled as before.
    expect(dayButton(20).disabled).toBe(true);
  });
});
