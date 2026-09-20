import { HIST_BOUNDS, HIST_SIZE } from '@query-analyser/contract/runtime';

/** Index of the bucket a duration belongs to. The last bucket is unbounded. */
export function bucketIndex(ms: number): number {
  for (let i = 0; i < HIST_BOUNDS.length; i++) {
    if (ms < HIST_BOUNDS[i]!) return i;
  }
  return HIST_SIZE - 1;
}

export function newHist(): number[] {
  return new Array<number>(HIST_SIZE).fill(0);
}

export function addToHist(hist: number[], ms: number): void {
  const i = bucketIndex(ms);
  hist[i] = (hist[i] ?? 0) + 1;
}
