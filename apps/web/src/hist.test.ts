import { describe, it, expect } from 'vitest';
import { HIST_SIZE } from '@query-analyser/contract/runtime';
import { histLabels } from './hist';

describe('histLabels', () => {
  it('one label per bucket', () => expect(histLabels()).toHaveLength(HIST_SIZE));
  it('labels match the shared bounds', () =>
    expect(histLabels()).toEqual(['< 100ms', '100–250ms', '250–500ms', '500ms–1s', '1–2.5s', '2.5–5s', '5–10s', '≥ 10s']));
});
