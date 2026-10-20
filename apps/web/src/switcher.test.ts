import { describe, it, expect } from 'vitest';
import { groupForSwitcher, orgsForSwitcher } from '@/components/dashboard/switcher';

describe('groupForSwitcher', () => {
  const orgs = [{ slug: 'acme', name: 'Acme' }, { slug: 'beta', name: 'Beta' }];
  const apps = {
    acme: [{ id: 'a1', name: 'api', env: 'prod', createdAt: '' }],
    beta: [{ id: 'b1', name: 'web', env: 'prod', createdAt: '' }],
  };
  it('groups apps under orgs, marks the current one, builds hrefs', () => {
    const g = groupForSwitcher(orgs, apps, { org: 'beta', app: 'b1' });
    expect(g.map((x) => x.org.slug)).toEqual(['acme', 'beta']);
    expect(g[1]!.apps[0]).toMatchObject({ id: 'b1', current: true, href: '/dashboard/beta/b1/queries' });
    expect(g[0]!.apps[0]!.current).toBe(false);
  });
  it('keeps an org with no apps (so + New app can target it)', () => {
    expect(groupForSwitcher(orgs, { acme: [] }, { org: 'acme', app: 'x' })[0]!.apps).toEqual([]);
  });
});

describe('orgsForSwitcher', () => {
  it('lists orgs with role, href and the current one marked', () =>
    expect(orgsForSwitcher([{ slug: 'acme', name: 'Acme', role: 'OWNER' }, { slug: 'b c', name: 'B', role: 'MEMBER' }], 'b c')).toEqual([
      { slug: 'acme', name: 'Acme', role: 'OWNER', href: '/dashboard/acme', current: false },
      { slug: 'b c', name: 'B', role: 'MEMBER', href: '/dashboard/b%20c', current: true },
    ]));
});
