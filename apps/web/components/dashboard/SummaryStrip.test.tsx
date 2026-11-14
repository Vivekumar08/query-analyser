// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SummaryStrip } from './SummaryStrip';
import type { SourceSummary, SummaryResponse } from '@/src/dashboard-types';

afterEach(cleanup);

const p = (value: number) => ({ value, basis: 'interpolated' as const });
const pg = (o: Partial<SourceSummary> = {}): SourceSummary => ({
  source: 'postgresql', counts: 'all-statements', count: 100, slowCount: 4, totalMs: '5000', avgMs: 50, maxMs: 900,
  p50: p(20), p95: p(300), p99: null, errors: 2, sampled: false, sampleRate: null, ...o,
});
const mongo = (o: Partial<SourceSummary> = {}): SourceSummary => ({
  source: 'mongodb', counts: 'slow-only', count: 7, slowCount: 7, totalMs: '1400', avgMs: 200, maxMs: 800,
  p50: p(150), p95: p(700), p99: p(790), errors: 0, sampled: false, sampleRate: null, ...o,
});
const mk = (o: Partial<SummaryResponse> = {}): SummaryResponse => ({
  grain: 'hourly', from: 'a', to: 'b', thresholdMs: 100, droppedNew: 0, sources: [pg(), mongo()], ...o,
});

describe('SummaryStrip', () => {
  it('renders one group per source and never a combined total', () => {
    render(<SummaryStrip summary={mk()} />);
    expect(screen.getByRole('region', { name: 'PostgreSQL' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'MongoDB' })).toBeTruthy();
    expect(screen.queryByText('107')).toBeNull();
    expect(screen.getByText('Slow queries (≥ 100 ms)')).toBeTruthy();
    expect(screen.getByText('Slow (≥ 100 ms)')).toBeTruthy();
  });
  it('shows the PostgreSQL cards and a dash for a null percentile', () => {
    render(<SummaryStrip summary={mk({ sources: [pg()] })} />);
    for (const l of ['Statements', 'Avg', 'P50', 'P95', 'P99', 'Errors']) expect(screen.getByText(l)).toBeTruthy();
    expect(screen.getByTitle(/not available/i)).toBeTruthy();
    expect(screen.getByLabelText('Not available').textContent).toBe('—');
  });
  it('shows only Slow queries, Avg and P95 for MongoDB', () => {
    render(<SummaryStrip summary={mk({ sources: [mongo()] })} />);
    expect(screen.queryByText('P50')).toBeNull();
    expect(screen.queryByText('Errors')).toBeNull();
    expect(screen.getByText('P95')).toBeTruthy();
  });
  it('labels a sampled source', () => {
    render(<SummaryStrip summary={mk({ sources: [pg({ sampled: true, sampleRate: 0.1 })] })} />);
    expect(screen.getByRole('region', { name: 'PostgreSQL · estimated (sampled at 10%)' })).toBeTruthy();
  });
  it('shows the quota notice only when shapes were dropped', () => {
    const { rerender } = render(<SummaryStrip summary={mk({ droppedNew: 3 })} />);
    expect(screen.getByText('Some new query shapes were not recorded in this window (3 drops) because this app reached its 5,000-shape limit. Queries already seen are still counted.')).toBeTruthy();
    rerender(<SummaryStrip summary={mk({ droppedNew: 1 })} />);
    expect(screen.getByText(/\(1 drop\)/)).toBeTruthy();
    rerender(<SummaryStrip summary={mk({ droppedNew: 0 })} />);
    expect(screen.queryByText(/were not recorded/)).toBeNull();
  });
  it('falls back to the word threshold when none is stored', () => {
    render(<SummaryStrip summary={mk({ thresholdMs: null })} />);
    expect(screen.getByText('Slow (≥ threshold)')).toBeTruthy();
    expect(screen.getByText('Slow queries (≥ threshold)')).toBeTruthy();
  });
  it('hides Errors in the MongoDB group even when errors is non-zero', () => {
    render(<SummaryStrip summary={mk({ sources: [mongo({ errors: 5 })] })} />);
    expect(screen.queryByText('Errors')).toBeNull();
  });
  it('labels a sampled source with no rate as plain (no estimate wording)', () => {
    render(<SummaryStrip summary={mk({ sources: [pg({ sampled: true, sampleRate: null })] })} />);
    expect(screen.getByRole('region', { name: 'PostgreSQL' })).toBeTruthy();
  });
});
