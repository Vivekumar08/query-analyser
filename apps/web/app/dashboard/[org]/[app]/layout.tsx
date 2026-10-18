import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/src/auth';
import { getApp, listApps, listOrgs } from '@/src/dashboard-api';
import { AppSwitcher } from '@/components/dashboard/AppSwitcher';
import { groupForSwitcher } from '@/components/dashboard/switcher';
import { MobileNav } from '@/components/dashboard/MobileNav';
import { RememberApp } from '@/components/dashboard/RememberApp';
import { Sidebar, SidebarNav } from '@/components/dashboard/Sidebar';
import { LogoutButton } from '@/app/_components/LogoutButton';

export default async function AppShell({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; app: string }>;
}) {
  const { org, app } = await params;
  const base = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}`;
  const session = await requireSession(`${base}/queries`);
  const t = session.accessToken;
  const refresh = `/api/auth/refresh?next=${encodeURIComponent(`${base}/queries`)}`;

  const [orgsRes, appRes] = await Promise.all([listOrgs(t), getApp(t, app)]);
  if (!orgsRes.ok) {
    if (orgsRes.status === 401) redirect(refresh);
    throw new Error('Could not load workspaces');
  }
  if (!appRes.ok && appRes.status === 401) redirect(refresh);
  // The URL carries the org slug; the API keys orgs by id.
  const currentOrg = orgsRes.data.find((o) => o.slug === org);
  // 403 and 404 both render not-found: never hint whether something exists.
  if (!currentOrg || !appRes.ok || appRes.data.orgId !== currentOrg.id) {
    if (!appRes.ok && appRes.status >= 500) throw new Error('Could not load app');
    notFound();
  }

  const appsByOrg = Object.fromEntries(
    await Promise.all(orgsRes.data.map(async (o) => {
      const r = await listApps(t, o.id);
      return [o.slug, r.ok ? r.data : []] as const;
    })),
  );
  const groups = groupForSwitcher(orgsRes.data, appsByOrg, { org, app });
  const switcher = (
    <AppSwitcher
      groups={groups}
      currentLabel={{ org: currentOrg.name, app: appRes.data.name }}
      newAppHref={`/onboarding?org=${encodeURIComponent(org)}`}
    />
  );
  const nav = <SidebarNav base={base} active="queries" />;
  const footer = (
    <div className="flex flex-col gap-2 text-sm">
      <span className="truncate text-muted-foreground">{session.user.email}</span>
      <LogoutButton />
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <RememberApp org={org} app={app} />
      <Sidebar switcher={switcher} nav={nav} footer={footer} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
          <MobileNav>
            <div className="p-3">{switcher}</div>
            <div className="flex-1 py-2">{nav}</div>
            <div className="border-t p-3">{footer}</div>
          </MobileNav>
          <span className="truncate text-sm font-medium">{appRes.data.name}</span>
        </div>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
