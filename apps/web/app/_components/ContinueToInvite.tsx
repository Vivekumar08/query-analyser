'use client';

import { useEffect, useState } from 'react';
import { readPendingInvite } from '@/src/pending-invite';

/**
 * The invite this browser was on before signup (src/pending-invite.ts), or
 * null. Read after mount: localStorage doesn't exist during server render,
 * and reading it there would mismatch on hydration.
 */
export function usePendingInvite(): string | null {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => setPath(readPendingInvite()), []);
  return path;
}

/**
 * The primary "Continue to your invite" action. A plain anchor, not
 * next/link: a Link would prefetch the tokened URL just for being on screen.
 */
export function ContinueToInviteLink({ path }: { path: string }) {
  return (
    <a href={path}
      className="inline-flex w-fit items-center rounded-full bg-primary px-5 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90">
      Continue to your invite
    </a>
  );
}
