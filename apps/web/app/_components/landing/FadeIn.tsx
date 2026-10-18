'use client';

import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * The only animated primitive on the landing page.
 *
 * A leaf on purpose: it wraps its children and nothing else, so the sections
 * around it stay server-rendered. Hoisting 'use client' to a section would
 * pull that whole subtree into the client bundle.
 *
 * Honours prefers-reduced-motion — for some people motion is a vestibular
 * trigger, not a preference.
 */
export function FadeIn({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const reduced = useReducedMotion();
  if (reduced) return <>{children}</>;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-64px' }}
      transition={{ duration: 0.4, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
