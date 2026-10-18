'use client';
import { useEffect } from 'react';
import { LAST_APP_COOKIE } from '@/src/landing';

/** Remembers the last app opened. Not sensitive: an org slug and app id. */
export function RememberApp({ org, app }: { org: string; app: string }) {
  useEffect(() => {
    document.cookie = `${LAST_APP_COOKIE}=${encodeURIComponent(`${org}/${app}`)}; Path=/dashboard; Max-Age=31536000; SameSite=Lax`;
  }, [org, app]);
  return null;
}
