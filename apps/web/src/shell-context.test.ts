import { describe, it, expect } from 'vitest';
import { checkShellAccess } from './shell-context';

const orgs = [{ id: 'o1', slug: 'acme' }, { id: 'o2', slug: 'beta' }];
const app = (orgId: string) => ({ ok: true as const, data: { orgId } });
const fail = (status: number) => ({ ok: false as const, status, error: 'x' });

describe('checkShellAccess', () => {
  it('ok when the app belongs to the org in the URL', () =>
    expect(checkShellAccess(orgs, 'acme', app('o1'))).toBe('ok'));
  it('not-found for an app in a different org', () =>
    expect(checkShellAccess(orgs, 'acme', app('o2'))).toBe('not-found'));
  it('not-found for an unknown org', () =>
    expect(checkShellAccess(orgs, 'nope', app('o1'))).toBe('not-found'));
  it('not-found for app 403 and 404', () => {
    expect(checkShellAccess(orgs, 'acme', fail(403))).toBe('not-found');
    expect(checkShellAccess(orgs, 'acme', fail(404))).toBe('not-found');
  });
  it('unavailable for app 5xx', () =>
    expect(checkShellAccess(orgs, 'acme', fail(503))).toBe('unavailable'));
});
