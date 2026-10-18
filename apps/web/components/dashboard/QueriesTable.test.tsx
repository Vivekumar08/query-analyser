// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueriesTable } from './QueriesTable';

afterEach(cleanup);

describe('QueriesTable', () => {
  it('links each row to its detail page and renders p95 through Percentile', () => {
    render(
      <QueriesTable
        base="/dashboard/acme/a1"
        search="range=7d"
        rows={[{ hash: 'h1', title: 'Order.find', signature: '{ a: eq }', count: 12, wasted: '4s', wastedShare: 1, avg: '333ms', p95: { value: 900, basis: 'floor' }, max: '900ms' }]}
      />,
    );
    expect(screen.getByRole('link', { name: /Order\.find/ }).getAttribute('href')).toBe('/dashboard/acme/a1/queries/h1?range=7d');
    expect(screen.getByText('≥ 900ms')).toBeTruthy();
  });
});
