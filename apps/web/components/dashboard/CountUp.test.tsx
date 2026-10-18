// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  useReducedMotion: vi.fn(),
  animate: vi.fn(() => ({ stop: vi.fn() })),
}));
import { useReducedMotion, animate } from 'framer-motion';
import { CountUp } from './CountUp';

describe('CountUp', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the final value immediately under reduced motion, without animating', () => {
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const { container } = render(<CountUp value={12345} kind="count" />);
    expect(container.textContent).toBe('12,345');
    expect(animate).not.toHaveBeenCalled();
  });
  it('starts the animation otherwise, and formats with the chosen kind', () => {
    vi.mocked(useReducedMotion).mockReturnValue(false);
    const { container } = render(<CountUp value={1500} kind="ms" />);
    expect(animate).toHaveBeenCalledWith(0, 1500, expect.objectContaining({ duration: 0.6 }));
    expect(container.textContent).toBe('0ms');
  });
});
