import Link from 'next/link';
import { Wordmark } from '@/components/brand/Logo';

/** The Mist shell without an app sidebar: org home and Account. */
export function BareShell({ children, back }: { children: React.ReactNode; back?: { href: string; label: string } }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between gap-4">
        <Wordmark />
        {back && (
          <Link href={back.href} className="text-sm text-muted-foreground hover:text-foreground">
            {back.label}
          </Link>
        )}
      </div>
      {children}
    </main>
  );
}
