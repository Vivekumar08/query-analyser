'use client';

import { useEffect, useRef, useState } from 'react';

const DEFAULT_CLASS = 'rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800';

export function CopyButton({
  text,
  label = 'Copy the install command',
  className = DEFAULT_CLASS,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear a pending reset on unmount so it never sets state on a gone component.
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard access can be denied; the snippet is selectable anyway.
          setCopied(false);
        }
      }}
      className={className}
      aria-label={label}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
