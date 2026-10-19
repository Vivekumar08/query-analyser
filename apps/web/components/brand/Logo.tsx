import Link from 'next/link';

/**
 * The Trace mark: spans on a timeline, the slow one ending in the ◐ the
 * product has always used. Drawn on a 64-unit grid in three optical sizes,
 * because detail that reads at 64 px turns to mush at 16:
 *
 * - large (> 40 px): four spans, the slow span capped with a half-filled ring;
 * - medium (21–40 px): thicker spans, the cap becomes a solid dot;
 * - small (≤ 20 px): three bold spans, no cap, for browser tabs.
 *
 * app/icon.svg, app/favicon.ico and app/apple-icon.png are rendered from the
 * same geometry (scripts/generate-icons.py).
 */

const INK = '#1E2235';
const LIFTED = '#343A5C';
const SPAN = '#B9BDDB';
const SLOW = '#9CA2E8';

type Rect = { x: number; y: number; w: number; h: number; slow?: boolean };

const LARGE: Rect[] = [
  { x: 12, y: 14, w: 22, h: 6 },
  { x: 20, y: 24, w: 18, h: 6 },
  { x: 14, y: 34, w: 27, h: 6, slow: true },
  { x: 24, y: 44, w: 12, h: 6 },
];
const MEDIUM: Rect[] = [
  { x: 12, y: 13, w: 22, h: 7 },
  { x: 20, y: 23.5, w: 18, h: 7 },
  { x: 14, y: 34, w: 27, h: 7, slow: true },
  { x: 24, y: 44.5, w: 12, h: 7 },
];
const SMALL: Rect[] = [
  { x: 10, y: 12, w: 24, h: 10 },
  { x: 10, y: 28, w: 44, h: 10, slow: true },
  { x: 22, y: 44, w: 16, h: 10 },
];

export function LogoMark({
  size = 24,
  tone = 'light',
  decorative = false,
  className,
}: {
  size?: number;
  /** `dark` lifts the tile off an ink background. */
  tone?: 'light' | 'dark';
  /** Set inside a wordmark, where the text already names the product. */
  decorative?: boolean;
  className?: string;
}) {
  const optical = size <= 20 ? 'small' : size <= 40 ? 'medium' : 'large';
  const spans = optical === 'small' ? SMALL : optical === 'medium' ? MEDIUM : LARGE;
  const tile = tone === 'dark' ? LIFTED : INK;
  const a11y = decorative
    ? { 'aria-hidden': true as const, focusable: 'false' as const }
    : { role: 'img', 'aria-label': 'query·analyser' };
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} {...a11y}>
      {optical === 'small' ? (
        <rect data-part="tile" x="0" y="0" width="64" height="64" rx="14" fill={tile} />
      ) : (
        <rect data-part="tile" x="2" y="2" width="60" height="60" rx="15" fill={tile} />
      )}
      {spans.map((s) => (
        <rect key={`${s.x}-${s.y}`} data-part="span" x={s.x} y={s.y} width={s.w} height={s.h} rx={s.h / 2} fill={s.slow ? SLOW : SPAN} />
      ))}
      {optical === 'medium' && <circle data-part="cap-dot" cx="48" cy="37.5" r="5.5" fill={SLOW} />}
      {optical === 'large' && (
        <>
          <path data-part="cap-half" d="M48 31.5 A5.5 5.5 0 0 0 48 42.5 Z" fill={SLOW} />
          <circle data-part="cap-ring" cx="48" cy="37" r="5" fill="none" stroke={SLOW} strokeWidth="2" />
        </>
      )}
    </svg>
  );
}

/** Mark plus "query·analyser", linking home. */
export function Wordmark({
  href = '/',
  size = 22,
  tone = 'light',
  className = '',
}: {
  href?: string;
  size?: number;
  tone?: 'light' | 'dark';
  className?: string;
}) {
  return (
    <Link href={href} className={`inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight ${className}`}>
      <LogoMark size={size} tone={tone} decorative />
      <span>
        query<span className="text-accent-text">·</span>analyser
      </span>
    </Link>
  );
}
