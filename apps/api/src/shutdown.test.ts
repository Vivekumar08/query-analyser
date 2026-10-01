import { describe, it, expect, vi } from 'vitest';
import { createShutdownHandler } from './shutdown.js';

describe('createShutdownHandler', () => {
  it('exits 0 promptly when close resolves before the timeout', async () => {
    const exit = vi.fn();
    const log = { info: vi.fn(), error: vi.fn() };
    const close = vi.fn(() => Promise.resolve());

    const shutdown = createShutdownHandler({ close, log, exit, timeoutMs: 10_000 });
    await shutdown('SIGINT');

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('forces exit(1) if close never resolves within the timeout, without waiting for real time', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const log = { info: vi.fn(), error: vi.fn() };
      // Never resolves — simulates a hung close().
      const close = vi.fn(() => new Promise<void>(() => {}));

      const shutdown = createShutdownHandler({ close, log, exit, timeoutMs: 10_000 });
      void shutdown('SIGTERM');

      // Nothing should have fired yet.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(exit).not.toHaveBeenCalled();

      // Timer fires at 10s.
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.error).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
