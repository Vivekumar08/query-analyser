import { safeNext } from './safe-next';

/*
 * The invite a new user was on when they had to sign up first.
 *
 * `next` carries /invite?token=… through /login → /signup, but not through
 * email verification: the verify link opens in a new tab with no `next`. So
 * /invite remembers its own path here, and /verify and onboarding offer
 * "Continue to your invite" until it is used, rejected for good, or a week old.
 *
 * The token is single-use and bound to the invitee's email, so holding it in
 * this browser's storage for a few days is an acceptable trade. Every access
 * is wrapped: storage can be missing or throw (private mode, blocked site
 * data), and none of this may ever break the invite or verify flows.
 */

export const PENDING_INVITE_KEY = 'qa:pendingInvite';
export const PENDING_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = '/invite?token=';

export function savePendingInvite(path: string, now = Date.now()): void {
  try {
    window.localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ path, savedAt: now }));
  } catch {
    // Storage unavailable: the invite still works, just without the reminder.
  }
}

export function clearPendingInvite(): void {
  try {
    window.localStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The stored invite path if it is fresh and safe, else null (dropping an
 * expired or malformed entry). Safe means: same-origin per safeNext, and
 * still an /invite?token= path afterwards — never just any in-app path.
 */
export function readPendingInvite(now = Date.now()): string | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const path = validPath(raw, now);
  if (path === null) clearPendingInvite();
  return path;
}

function validPath(raw: string, now: number): string | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const { path, savedAt } = v as { path?: unknown; savedAt?: unknown };
  if (typeof path !== 'string' || typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  const age = now - savedAt;
  if (age < 0 || age > PENDING_INVITE_TTL_MS) return null;
  const safe = safeNext(path, window.location.origin, '');
  return safe.startsWith(PREFIX) && safe.length > PREFIX.length ? safe : null;
}
