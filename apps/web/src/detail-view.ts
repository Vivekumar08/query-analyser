import type { SeriesPoint, SuggestionField } from './dashboard-types';
import { histLabels } from './hist';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Fields stay in the given (index key) order; non-identifier names are quoted. */
export function createIndexCall(model: string, s: SuggestionField[]): string {
  const fields = s.map(({ field, dir }) => `${IDENT.test(field) ? field : JSON.stringify(field)}: ${dir}`).join(', ');
  return `${model}.collection.createIndex({ ${fields} })`;
}

export function histogramData(hist: number[]): { bucket: string; count: number }[] {
  const labels = histLabels();
  return hist.map((count, i) => ({ bucket: labels[i] ?? `#${i}`, count }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The API sends p95 as `{value: 0, basis: 'floor'}` for a bucket with no
 * calls; that 0 is "no data", not a fast query, so it plots as a gap.
 */
export function trendData(points: SeriesPoint[], grain: 'hourly' | 'daily') {
  return points.map((p) => {
    const d = new Date(p.at);
    const label = grain === 'hourly'
      ? `${String(d.getUTCHours()).padStart(2, '0')}:00`
      : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    return { label, at: p.at, calls: p.count, p95: p.count > 0 ? p.p95.value : null };
  });
}
