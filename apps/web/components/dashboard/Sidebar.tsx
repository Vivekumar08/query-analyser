import Link from 'next/link';
import { BarChart3, Bell, LayoutDashboard, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const SOON = [
  { name: 'Overview', icon: LayoutDashboard },
  { name: 'Alerts', icon: Bell },
  { name: 'Settings', icon: Settings },
];

export function SidebarNav({ base, active }: { base: string; active: 'queries' }) {
  return (
    <nav className="flex flex-col gap-0.5 px-2 text-sm">
      <Link
        href={`${base}/queries`}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 font-medium',
          active === 'queries' ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted',
        )}
      >
        <BarChart3 className="size-4" aria-hidden /> Queries
      </Link>
      {SOON.map(({ name, icon: Icon }) => (
        <div key={name} aria-disabled="true" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground">
          <Icon className="size-4" aria-hidden /> <span>{name}</span>
          <Badge variant="secondary" className="ml-auto text-[10px]">Soon</Badge>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({
  switcher,
  nav,
  footer,
}: {
  switcher: React.ReactNode;
  nav: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="p-3">{switcher}</div>
      <div className="flex-1 py-2">{nav}</div>
      <div className="border-t p-3">{footer}</div>
    </aside>
  );
}
