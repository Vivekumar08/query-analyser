import { getShellContext } from '@/src/shell-context';
import { AppSwitcher } from '@/components/dashboard/AppSwitcher';
import { groupForSwitcher, orgsForSwitcher } from '@/components/dashboard/switcher';
import { MobileNav } from '@/components/dashboard/MobileNav';
import { RememberApp } from '@/components/dashboard/RememberApp';
import { Sidebar, SidebarAccount, SidebarNav } from '@/components/dashboard/Sidebar';
import { isAdminRole } from '@/src/dashboard-types';
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
  const { session, currentOrg, app: appData, orgs, appsByOrg } = await getShellContext(org, app);
  const groups = groupForSwitcher(orgs, appsByOrg, { org, app });
  const switcher = (
    <AppSwitcher
      groups={groups}
      orgs={orgsForSwitcher(orgs, org)}
      currentLabel={{ org: currentOrg.name, app: appData.name }}
      newAppHref={isAdminRole(currentOrg.role) ? `/onboarding?org=${encodeURIComponent(org)}` : null}
    />
  );
  const nav = <SidebarNav base={base} />;
  const footer = (
    <div className="flex flex-col gap-2 text-sm">
      <SidebarAccount name={session.user.name} email={session.user.email} />
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
          <span className="truncate text-sm font-medium">{appData.name}</span>
        </div>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
