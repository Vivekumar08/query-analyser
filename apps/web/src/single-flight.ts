/**
 * Collapses concurrent calls for the same key into one execution.
 *
 * The refresh endpoint is why this exists. The API rotates refresh tokens and
 * revokes the whole family on replay, so two concurrent refreshes with the
 * same token look like an attack: the first rotates, the second presents a
 * consumed token, and the user is logged out of everything. Serialising them
 * turns that into one rotation both callers share.
 *
 * Deliberately has no Next imports. Next 16's docs say proxy "should not
 * attempt relying on shared modules or globals", so this must be used from a
 * route handler, never from proxy.ts.
 *
 * Scope note: this is per-process. With more than one web replica a refresh
 * could still race across instances. The deployment runs a single replica, so
 * it is effective here; a shared lock would be the fix if that changes.
 */
export function singleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>();

  return function run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing;

    // `finally` rather than `then`: the key must be released on rejection too,
    // or one transient failure poisons every later call with a stale error.
    const promise = fn().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };
}
