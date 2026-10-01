export interface ShutdownLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface ShutdownDeps {
  /** Should resolve once the app has finished closing. */
  close: () => Promise<void>;
  log: ShutdownLogger;
  exit: (code: number) => void;
  /** Defaults to 10s. */
  timeoutMs?: number;
}

/**
 * Builds a signal handler that closes the app gracefully, but forces a hard
 * exit if `close()` hasn't resolved within `timeoutMs` — otherwise a stuck
 * connection/handle can hang shutdown forever. The timer is `unref()`'d so it
 * never itself keeps the process alive.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 10_000;

  return async (signal: string): Promise<void> => {
    deps.log.info({ signal }, 'shutting down');

    const timer = setTimeout(() => {
      deps.log.error({ signal, timeoutMs }, 'graceful shutdown timed out; forcing exit');
      deps.exit(1);
    }, timeoutMs);
    timer.unref();

    await deps.close();
    clearTimeout(timer);
    deps.exit(0);
  };
}
