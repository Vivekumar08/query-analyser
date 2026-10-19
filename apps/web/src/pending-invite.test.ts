// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PENDING_INVITE_KEY,
  PENDING_INVITE_TTL_MS,
  clearPendingInvite,
  readPendingInvite,
  savePendingInvite,
} from './pending-invite';
import { installJsdomLocalStorage } from './jsdom-storage';

installJsdomLocalStorage();

const NOW = 1_800_000_000_000;

beforeEach(() => localStorage.clear());

describe('pending invite', () => {
  it('saves {path, savedAt} under qa:pendingInvite and reads the path back', () => {
    savePendingInvite('/invite?token=abc', NOW);
    expect(JSON.parse(localStorage.getItem(PENDING_INVITE_KEY)!)).toEqual({ path: '/invite?token=abc', savedAt: NOW });
    expect(readPendingInvite(NOW + 1000)).toBe('/invite?token=abc');
  });

  it('clears it', () => {
    savePendingInvite('/invite?token=abc', NOW);
    clearPendingInvite();
    expect(localStorage.getItem(PENDING_INVITE_KEY)).toBeNull();
    expect(readPendingInvite(NOW)).toBeNull();
  });

  it('ignores (and drops) one older than 7 days', () => {
    savePendingInvite('/invite?token=abc', NOW);
    expect(readPendingInvite(NOW + PENDING_INVITE_TTL_MS)).toBe('/invite?token=abc');
    expect(readPendingInvite(NOW + PENDING_INVITE_TTL_MS + 1)).toBeNull();
    expect(localStorage.getItem(PENDING_INVITE_KEY)).toBeNull();
  });

  it.each([
    ['not json', '{nope'],
    ['a bare string', JSON.stringify('/invite?token=abc')],
    ['no savedAt', JSON.stringify({ path: '/invite?token=abc' })],
    ['a string savedAt', JSON.stringify({ path: '/invite?token=abc', savedAt: String(NOW) })],
    ['a future savedAt', JSON.stringify({ path: '/invite?token=abc', savedAt: NOW + 60_000 })],
    ['a non-string path', JSON.stringify({ path: 42, savedAt: NOW })],
    ['another in-app path', JSON.stringify({ path: '/dashboard', savedAt: NOW })],
    ['an invite with no token', JSON.stringify({ path: '/invite', savedAt: NOW })],
    ['a protocol-relative path', JSON.stringify({ path: '//evil.com/invite?token=abc', savedAt: NOW })],
    ['a bare //evil.com', JSON.stringify({ path: '//evil.com', savedAt: NOW })],
    ['an absolute URL', JSON.stringify({ path: 'https://evil.com/invite?token=abc', savedAt: NOW })],
    ['a backslash trick', JSON.stringify({ path: '/\\evil.com/invite?token=abc', savedAt: NOW })],
    ['a dot-segment trick', JSON.stringify({ path: '/.//evil.com/invite?token=abc', savedAt: NOW })],
  ])('ignores a malformed stored value: %s', (_label, raw) => {
    localStorage.setItem(PENDING_INVITE_KEY, raw);
    expect(readPendingInvite(NOW)).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
    try {
      expect(() => savePendingInvite('/invite?token=abc', NOW)).not.toThrow();
      expect(readPendingInvite(NOW)).toBeNull();
      expect(() => clearPendingInvite()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', real);
    }
  });
});
