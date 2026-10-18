import { parseNumericString } from '@query-analyser/contract';

/**
 * Milliseconds from the API: a number, or a NumericString (BigInt behind it).
 * `parseNumericString` refuses integers above Number.MAX_SAFE_INTEGER; those
 * are still valid totals, so fall back to Number() after validating the digits.
 * Precision above 2^53 is far below what a duration display shows.
 */
export function toMs(v: number | string): number {
  if (typeof v === 'number') return v;
  try {
    return parseNumericString(v);
  } catch (err) {
    if (/^\d+$/.test(v)) return Number(v);
    throw err;
  }
}

/**
 * The only way the dashboard renders a duration. `totalMs` is a numeric
 * string; it is converted here, before any arithmetic, so no page can add or
 * divide a string by accident.
 */
export function formatMs(v: number | string): string {
  const ms = toMs(v);
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours.toLocaleString('en-US')}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

export function formatAvg(totalMs: string, count: number): string {
  if (count <= 0) return '—';
  return formatMs(toMs(totalMs) / count);
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
