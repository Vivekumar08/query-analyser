/** Client helpers shared by the Account page's cards (same behaviour as settings/Members). */

export const GENERIC = 'Something went wrong. Please try again.';
export const HEADING_CLASS = 'text-base font-semibold outline-none';

/** The access token expired: refresh it, then come back to this page. */
export function refreshSession(): void {
  window.location.assign(`/api/auth/refresh?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

/** The BFF's fixed error copy, or the generic message. */
export async function errorOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof data.error === 'string' && data.error ? data.error : GENERIC;
}

export const JSON_HEADERS = { 'content-type': 'application/json' };
