'use client';
import { useEffect, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';
import { formatCount, formatMs } from '@/src/format';

// Server Components can't pass functions to client components, so the formatter is chosen by key.
const FORMATTERS = { count: formatCount, ms: formatMs } as const;

export function CountUp({ value, kind }: { value: number; kind: keyof typeof FORMATTERS }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  useEffect(() => {
    if (reduce) {
      setShown(value);
      return;
    }
    const c = animate(0, value, { duration: 0.6, ease: 'easeOut', onUpdate: (v) => setShown(v) });
    return () => c.stop();
  }, [value, reduce]);
  return <>{FORMATTERS[kind](reduce ? value : shown)}</>;
}
