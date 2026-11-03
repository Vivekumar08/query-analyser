// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AllTimeStats } from './AllTimeStats';

afterEach(cleanup);

describe('AllTimeStats', () => {
  it('shows a dash for null p95 and p99', () => {
    render(<AllTimeStats d={{ count: 5, totalMs: '500', maxMs: 300, p95: null, p99: null } as never} />);
    expect(screen.getAllByLabelText('Not available')).toHaveLength(2);
    expect(screen.getAllByText(/—/).length).toBeGreaterThanOrEqual(2);
  });
});
