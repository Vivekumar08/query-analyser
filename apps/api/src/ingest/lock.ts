// Tail of each app's in-flight work. In-process only.
const tails = new Map<string, Promise<void>>();

/** Runs `fn` after every earlier call for the same app has finished; releases on throw. */
export async function withAppLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(appId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine);
  tails.set(appId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(appId) === tail) tails.delete(appId);
  }
}

/** Number of apps with work in flight (tests). */
export const lockCount = (): number => tails.size;
