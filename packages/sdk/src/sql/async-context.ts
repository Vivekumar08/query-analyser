/** What `hasAsyncContextFrame` reads; injectable for tests. */
export interface RuntimeFlags { version: string; execArgv: readonly string[]; nodeOptions?: string | undefined }

const OFF_FLAG = '--no-async-context-frame';

const isOffFlag = (arg: unknown): boolean => typeof arg === 'string' && arg.replace(/_/g, '-') === OFF_FLAG;

function current(): RuntimeFlags {
  return { version: process.versions.node, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS };
}

/**
 * Whether `AsyncLocalStorage` runs on AsyncContextFrame: Node 24 and later, unless switched off with
 * `--no-async-context-frame` (on the command line or in NODE_OPTIONS). Without it (Node 20/22), the
 * first `als.run()` turns on promise hooks for the whole process, which slows every unrelated await.
 * Never throws; anything unreadable is false.
 */
export function hasAsyncContextFrame(flags?: RuntimeFlags): boolean {
  try {
    const { version, execArgv, nodeOptions } = flags ?? current();
    if (typeof version !== 'string') return false;
    const major = Number(version.split('.')[0]);
    if (!Number.isInteger(major) || major < 24) return false;
    if (Array.isArray(execArgv) && execArgv.some(isOffFlag)) return false;
    if (typeof nodeOptions === 'string' && nodeOptions.split(/\s+/).some(isOffFlag)) return false;
    return true;
  } catch {
    return false;
  }
}
