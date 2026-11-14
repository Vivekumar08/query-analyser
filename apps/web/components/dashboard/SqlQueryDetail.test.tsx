// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { QueryDetail } from '@/src/dashboard-types';

const bars: number[] = [];
vi.mock('./HistogramChart', () => ({ HistogramChart: ({ data }: { data: unknown[] }) => { bars.push(data.length); return <div data-testid="hist" />; } }));
vi.mock('./TrendChart', () => ({ TrendChart: () => <div data-testid="trend" /> }));

import { SqlQueryDetail } from './SqlQueryDetail';

afterEach(() => { cleanup(); bars.length = 0; });

const sqlDetail: QueryDetail = {
  hash: 'h', signature: 'select ?', model: 'User', operation: 'findMany',
  firstSeen: '2026-10-18T09:00:00.000Z', lastSeen: '2026-10-18T10:00:00.000Z',
  count: 120, totalMs: '4800', maxMs: 900, avgMs: 40,
  p50: { value: 20, basis: 'interpolated' }, p95: { value: 200, basis: 'interpolated' }, p99: null,
  hist: [1, 2, 3, 0, 0, 0, 0, 0], histFine: null, redactedSample: null, encryptedSample: null, advice: null,
  source: 'postgresql', orm: 'prisma', database: 'app', collection: 'User',
  sqlText: 'SELECT "id" FROM "User" WHERE "email" = ? LIMIT ?', lastErrorCode: '23505', errors: 3,
  sampled: false, sampleRate: null, thresholdMs: 100,
};

describe('SqlQueryDetail', () => {
  it('shows the full SQL, the stats, the last SQLSTATE and the metadata', () => {
    render(<SqlQueryDetail detail={sqlDetail} series={null} rangeLabel="last 24h" />);
    expect(screen.getByText(sqlDetail.sqlText!)).toBeTruthy();
    expect(screen.getByText('last SQLSTATE 23505')).toBeTruthy();
    expect(screen.getByText('Prisma')).toBeTruthy();
    expect(screen.getByText('User.findMany')).toBeTruthy();
    expect(screen.getByLabelText('Copy the SQL')).toBeTruthy();
    for (const l of ['Calls', 'Total time', 'Avg', 'P50', 'P95', 'P99', 'Max', 'Errors']) expect(screen.getByText(l)).toBeTruthy();
    expect(screen.queryByText(/createIndex|Compass/)).toBeNull();
  });
  it('uses the fine histogram when present', () => {
    render(<SqlQueryDetail detail={{ ...sqlDetail, histFine: new Array(14).fill(1) }} series={null} rangeLabel="x" />);
    expect(bars).toEqual([14]);
  });
  it('falls back to the 8-bucket histogram', () => {
    render(<SqlQueryDetail detail={sqlDetail} series={null} rangeLabel="x" />);
    expect(bars).toEqual([8]);
  });
  it('labels a sampled detail', () => {
    render(<SqlQueryDetail detail={{ ...sqlDetail, sampled: true, sampleRate: 0.1 }} series={null} rangeLabel="x" />);
    expect(screen.getByText('estimated (sampled at 10%)')).toBeTruthy();
  });
});
