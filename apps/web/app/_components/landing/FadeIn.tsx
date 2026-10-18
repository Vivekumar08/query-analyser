import type { ReactNode } from 'react';

/**
 * Scroll reveal for the landing page, in CSS only (see `.reveal` in
 * globals.css).
 *
 * Server-rendered content must never start hidden: crawlers, no-JS visitors
 * and full-page captures would see empty space. So the element is plain,
 * visible markup; browsers that support scroll-driven animations AND whose
 * user hasn't asked for reduced motion get a gentle fade-up as it enters the
 * viewport. Everyone else just sees the content. No client JS, no hydration
 * branch to mismatch.
 */
export function FadeIn({ children }: { children: ReactNode; delay?: number }) {
  return <div className="reveal">{children}</div>;
}
