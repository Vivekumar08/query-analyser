import Link from 'next/link';
import { GlassCard } from '@/components/marketing/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LogoutButton } from '@/app/_components/LogoutButton';
import { BlockedAction } from './BlockedAction';
import { PLAN_LIMIT_COPY } from '@/src/plan-limits';
import { ROLE_LABEL, isAdminRole, type Role } from '@/src/dashboard-types';
import { ACCOUNT_HREF, NEW_ORG_HREF, orgPath } from '@/src/landing';

type OrgRef = { slug: string; name: string; role: Role };

function EmptyState({ org, suspended, canCreateOrg }: { org: OrgRef; suspended: boolean; canCreateOrg: boolean }) {
  if (suspended) return <p className="text-foreground">This organisation is suspended.</p>;
  if (isAdminRole(org.role)) {
    return (
      <Button asChild className="self-start">
        <Link href={`/onboarding?org=${encodeURIComponent(org.slug)}`}>Connect your first app</Link>
      </Button>
    );
  }
  return (
    <>
      <p className="text-foreground">No apps yet. Ask an admin to connect one.</p>
      {canCreateOrg ? (
        <Button asChild variant="outline" className="self-start">
          <Link href={NEW_ORG_HREF}>Create your own organisation</Link>
        </Button>
      ) : (
        <BlockedAction label="Create your own organisation" reason={PLAN_LIMIT_COPY.orgs} />
      )}
    </>
  );
}

/** Home for an org with no apps (or a suspended one): the empty state and a way elsewhere. */
export function OrgHome({
  org,
  orgs,
  suspended,
  canCreateOrg,
}: {
  org: OrgRef;
  orgs: OrgRef[];
  suspended: boolean;
  /** False when the plan allows no more orgs: the create button shows disabled with the reason. */
  canCreateOrg: boolean;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <Badge variant="secondary">{ROLE_LABEL[org.role]}</Badge>
      </div>
      <GlassCard strong className="flex flex-col gap-4 p-6">
        <EmptyState org={org} suspended={suspended} canCreateOrg={canCreateOrg} />
      </GlassCard>
      <nav aria-label="Organisations" className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Organisations</h2>
        <ul className="flex flex-col gap-1">
          {orgs.map((o) => {
            const current = o.slug === org.slug;
            return (
              <li key={o.slug}>
                <Link
                  href={orgPath(o.slug)}
                  aria-current={current ? 'page' : undefined}
                  className={`flex items-center justify-between gap-3 rounded-full px-4 py-2 text-sm transition-colors hover:bg-white/70 ${current ? 'bg-white/70 font-medium text-foreground' : 'text-foreground'}`}
                >
                  <span className="truncate">{o.name}</span>
                  <span className="text-xs text-muted-foreground">{ROLE_LABEL[o.role]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-3 border-t pt-3">
          <Link href={ACCOUNT_HREF} className="text-sm font-medium text-accent-text underline-offset-4 hover:underline">Account</Link>
          <LogoutButton />
        </div>
      </nav>
    </>
  );
}
