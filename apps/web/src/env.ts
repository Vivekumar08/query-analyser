export interface WebEnv {
  /** Absolute origin of the API, with no trailing slash. */
  API_ORIGIN: string;
}

/**
 * Validates the web app's environment.
 *
 * Mirrors `apps/api/src/config.ts`: the value is required with no default, so
 * a misconfigured deployment fails immediately and names the variable, rather
 * than rendering a page whose every fetch 404s. A relative value is rejected
 * for the same reason — it would resolve against whatever origin the server
 * happens to be on, which is silent and environment-dependent.
 */
export function loadWebEnv(env: Record<string, string | undefined>): WebEnv {
  const raw = env.API_ORIGIN;
  if (!raw) throw new Error('invalid configuration: API_ORIGIN is required');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid configuration: API_ORIGIN must be an absolute URL, got "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid configuration: API_ORIGIN must be http(s), got "${parsed.protocol}"`);
  }

  return { API_ORIGIN: raw.replace(/\/+$/, '') };
}
