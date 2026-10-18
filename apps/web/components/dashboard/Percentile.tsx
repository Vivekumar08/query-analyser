import type { PercentileResult } from '@query-analyser/contract';
import { formatMs } from '@/src/format';

/**
 * The only way a percentile is rendered. `basis` is in the glyph, not a
 * tooltip: `floor` means the rank landed in the unbounded top bucket, so the
 * service refuses to claim more than a lower bound.
 */
export function Percentile({
  label,
  value,
  showLabel = true,
}: {
  label: string;
  value: PercentileResult | null;
  showLabel?: boolean;
}) {
  const prefix = showLabel ? `${label} ` : '';
  if (!value) return <span className="tabular-nums">{prefix}—</span>;
  const floor = value.basis === 'floor';
  return (
    <span
      className="tabular-nums"
      title={floor ? `At least ${formatMs(value.value)} — the slowest calls exceed the top histogram bucket` : undefined}
    >
      {prefix}
      {floor ? '≥' : '≈'} {formatMs(value.value)}
    </span>
  );
}
