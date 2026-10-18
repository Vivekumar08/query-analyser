import { HIST_BOUNDS } from '@query-analyser/contract/runtime';

const short = (ms: number) => (ms < 1000 ? `${ms}ms` : `${ms / 1000}s`);

/** Human labels for the shared histogram buckets, lowest first. */
export function histLabels(): string[] {
  const labels = [`< ${short(HIST_BOUNDS[0])}`];
  for (let i = 1; i < HIST_BOUNDS.length; i++) {
    const lo = HIST_BOUNDS[i - 1]!;
    const hi = HIST_BOUNDS[i]!;
    labels.push(lo < 1000 && hi >= 1000 ? `${short(lo)}–${short(hi)}` : lo >= 1000 ? `${lo / 1000}–${short(hi)}` : `${lo}–${short(hi)}`);
  }
  labels.push(`≥ ${short(HIST_BOUNDS[HIST_BOUNDS.length - 1]!)}`);
  return labels;
}
