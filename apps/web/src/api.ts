import { loadWebEnv } from './env.js';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code?: string; error: string };

/**
 * Resolves the API origin on EVERY call.
 *
 * The Dockerfile sets `API_ORIGIN=https://placeholder.invalid` at build time
 * so the build does not fail before this is wired up. Reading it at module
 * scope would capture that placeholder and bake it into any statically
 * prerendered RSC payload, which fails only in production and only silently.
 */
export function apiOrigin(): string {
  return loadWebEnv(process.env).API_ORIGIN;
}

/**
 * Server-side API call. Never throws on an HTTP error — it returns a
 * discriminated result, because callers branch on 401 (refresh) and on the
 * 403 `code` (verification), and an exception would surface as a 500 page.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  accessToken?: string,
): Promise<ApiResult<T>> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type') && init?.body) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  let res: Response;
  try {
    res = await fetch(`${apiOrigin()}${path}`, {
      ...init,
      headers,
      // Next caches fetches by default. A cached /v1/me would serve one
      // user's identity to the next visitor.
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.name : 'network error' };
  }

  const raw = await res.text();
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }

  if (res.ok) return { ok: true, data: parsed as T };

  const body = (parsed ?? {}) as { error?: string; code?: string };
  return {
    ok: false,
    status: res.status,
    code: body.code,
    error: body.error ?? `request failed with ${res.status}`,
  };
}
