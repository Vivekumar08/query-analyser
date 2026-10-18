// @vitest-environment jsdom
// apps/web/components/dashboard/Percentile.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Percentile } from './Percentile';

describe('Percentile', () => {
  // vitest runs without globals, so RTL does not auto-unmount between tests.
  afterEach(cleanup);

  it('interpolated renders ≈', () => {
    const { container } = render(<Percentile label="p95" value={{ value: 300, basis: 'interpolated' }} />);
    expect(container.textContent).toBe('p95 ≈ 300ms');
  });
  it('floor renders ≥', () => {
    const { container } = render(<Percentile label="p95" value={{ value: 14002, basis: 'floor' }} />);
    expect(container.textContent).toBe('p95 ≥ 14s');
  });
  it('null renders a dash', () => {
    const { container } = render(<Percentile label="p99" value={null} />);
    expect(container.textContent).toBe('p99 —');
  });
  it('can hide the label', () => {
    const { container } = render(<Percentile label="p95" showLabel={false} value={{ value: 300, basis: 'interpolated' }} />);
    expect(container.textContent).toBe('≈ 300ms');
  });
  it('floor carries an explanatory title', () => {
    const { getByTitle } = render(<Percentile label="p95" value={{ value: 14002, basis: 'floor' }} />);
    expect(getByTitle(/at least/i)).toBeTruthy();
  });
});
