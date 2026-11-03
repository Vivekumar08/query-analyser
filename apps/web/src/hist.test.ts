import { describe, it, expect } from 'vitest';
import { FINE_HIST_BOUNDS, HIST_SIZE } from '@query-analyser/contract/runtime';
import { histLabels } from './hist';

describe('histLabels', () => {
  it('one label per bucket', () => expect(histLabels()).toHaveLength(HIST_SIZE));
  it('labels match the shared bounds', () =>
    expect(histLabels()).toEqual(['< 100ms', '100–250ms', '250–500ms', '500ms–1s', '1–2.5s', '2.5–5s', '5–10s', '≥ 10s']));
  it('labels the fine buckets', () => expect(histLabels(FINE_HIST_BOUNDS)).toEqual(['< 1ms', '1–2ms', '2–5ms', '5–10ms', '10–25ms', '25–50ms', '50–100ms', '100–250ms', '250–500ms', '500ms–1s', '1–2.5s', '2.5–5s', '5–10s', '≥ 10s']));
  it('the default is still the 8 Mongo buckets', () => expect(histLabels()).toHaveLength(8));
});
