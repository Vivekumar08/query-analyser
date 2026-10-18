/** Where to send a user whose session expired mid-onboarding: refresh, then come back here. */
export function refreshHref(path: string): string {
  return `/api/auth/refresh?next=${encodeURIComponent(path)}`;
}

/** Full navigation (the refresh route sets cookies, so it must not be a client transition). */
export function navigateToRefresh(): void {
  window.location.assign(refreshHref(`${window.location.pathname}${window.location.search}`));
}
