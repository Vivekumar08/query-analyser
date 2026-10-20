// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const replace = vi.fn();
const url = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/dashboard/o/a/queries',
  useSearchParams: () => new URLSearchParams(url.search),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

import { RangeControl } from './RangeControl';

afterEach(() => {
  cleanup();
  replace.mockClear();
  url.search = '';
  vi.useRealTimers();
});

describe('RangeControl', () => {
  it('disables presets longer than the plan keeps and says why', () => {
    render(<RangeControl value={{ kind: 'preset', preset: '24h' }} retentionDays={7} />);
    const long = screen.getByRole('radio', { name: '30d' }) as HTMLButtonElement;
    expect(long.disabled).toBe(true);
    expect(long.getAttribute('title')).toBe('Kept for 7 days on your plan');
    expect(long.getAttribute('aria-describedby')).toBe(screen.getByText('Kept for 7 days on your plan').id);
    expect(screen.getByRole('radio', { name: '7d' }).getAttribute('aria-describedby')).toBeNull();
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
    // The boundary: 7 days back lands mid-day on the 11th, which the prune has removed.
    expect(dayButton(11).disabled).toBe(true);
    expect(dayButton(12).disabled).toBe(false);
    // Future days stay disabled as before.
    expect(dayButton(20).disabled).toBe(true);
  });

  it('a bookmarked range the plan does not keep is replaced by the canonical one in the URL', () => {
    url.search = 'range=30d&model=User&page=2';
    // The server already fell back to 24h (parseRange).
    render(<RangeControl value={{ kind: 'preset', preset: '24h' }} retentionDays={7} />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/dashboard/o/a/queries?model=User&page=2', { scroll: false });
  });

  it('a clamped custom range rewrites its start day', () => {
    url.search = 'range=custom&from=2020-01-01&to=2026-10-15';
    render(<RangeControl value={{ kind: 'custom', from: '2026-10-12T00:00:00.000Z', to: '2026-10-15T23:59:59.999Z' }} retentionDays={7} />);
    expect(replace).toHaveBeenCalledWith('/dashboard/o/a/queries?range=custom&from=2026-10-12&to=2026-10-15', { scroll: false });
  });

  it('a canonical URL is left alone', () => {
    url.search = 'range=7d';
    render(<RangeControl value={{ kind: 'preset', preset: '7d' }} retentionDays={7} />);
    expect(replace).not.toHaveBeenCalled();
  });
});
