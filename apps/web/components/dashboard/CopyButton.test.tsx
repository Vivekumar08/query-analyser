// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows Copied then resets', async () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<CopyButton text="x" />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('button').textContent).toBe('Copied');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole('button').textContent).toBe('Copy');
  });
  it('clears its reset timer on unmount', async () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { unmount } = render(<CopyButton text="x" />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
