import { HIST_BOUNDS } from '@query-analyser/contract/runtime';

const short = (ms: number) => (ms < 1000 ? `${ms}ms` : `${ms / 1000}s`);

/** Human labels for the shared histogram buckets, lowest first. */
export function histLabels(bounds: readonly number[] = HIST_BOUNDS): string[] {
  const labels = [`< ${short(bounds[0]!)}`];
  for (let i = 1; i < bounds.length; i++) {
    const lo = bounds[i - 1]!;
    const hi = bounds[i]!;
    labels.push(lo < 1000 && hi >= 1000 ? `${short(lo)}–${short(hi)}` : lo >= 1000 ? `${lo / 1000}–${short(hi)}` : `${lo}–${short(hi)}`);
  }
  labels.push(`≥ ${short(bounds[bounds.length - 1]!)}`);
  return labels;
}
