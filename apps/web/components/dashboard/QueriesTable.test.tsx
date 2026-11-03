// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueriesTable } from './QueriesTable';

afterEach(cleanup);

const baseRow = { hash: 'h1', title: 'Order.find', signature: '{ a: eq }', count: 12, wasted: '4s', wastedShare: 1, avg: '333ms', p95: null, max: '900ms',
  source: 'mongodb', sourceLabel: 'MongoDB', ormLabel: 'Mongoose / driver', errors: 0, sampledLabel: null };

describe('QueriesTable', () => {
  it('shows the source badge, an Errors column and the sampled label', () => {
    render(
      <QueriesTable base="/b" search="" rows={[{ ...baseRow, source: 'postgresql', sourceLabel: 'PostgreSQL', ormLabel: 'Prisma', errors: 3, sampledLabel: 'estimated (sampled at 10%)' }]} />,
    );
    expect(screen.getByText('PostgreSQL · Prisma')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Errors' })).toBeTruthy();
    expect(screen.getByText('estimated (sampled at 10%)')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
  it('renders a null p95 as a dash and no sampled line for Mongo', () => {
    render(<QueriesTable base="/b" search="" rows={[baseRow]} />);
    expect(screen.getByText('MongoDB · Mongoose / driver')).toBeTruthy();
    expect(screen.queryByText(/estimated/)).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });
  it('links each row to its detail page and renders p95 through Percentile', () => {
    render(
      <QueriesTable
        base="/dashboard/acme/a1"
        search="range=7d"
        rows={[{ hash: 'h1', title: 'Order.find', signature: '{ a: eq }', count: 12, wasted: '4s', wastedShare: 1, avg: '333ms', p95: { value: 900, basis: 'floor' }, max: '900ms', source: 'mongodb', sourceLabel: 'MongoDB', ormLabel: 'Mongoose / driver', errors: 0, sampledLabel: null }]}
      />,
    );
    expect(screen.getByRole('link', { name: /Order\.find/ }).getAttribute('href')).toBe('/dashboard/acme/a1/queries/h1?range=7d');
    expect(screen.getByText('≥ 900ms')).toBeTruthy();
  });
});
