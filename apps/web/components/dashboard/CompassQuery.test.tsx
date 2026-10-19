// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { CompassQuery } from './CompassQuery';

afterEach(cleanup);

const envelope = { v: 1 as const, epk: 'ZXBr', iv: 'aXZpdml2aXZpdml2', ct: 'Y3Q=' };
const base = {
  model: 'Category',
  redactedSample: { filter: { email: '<string>' }, sort: { createdAt: '<number>' } },
  appId: 'a1',
  settingsHref: '/dashboard/o/a/settings#samples',
};

describe('CompassQuery', () => {
  it('shows the placeholder command for the default collection, editable, with copy', () => {
    render(<CompassQuery {...base} encryptedSample={null} sampleKeyEnabled={false} canManage={false} />);
    expect(screen.getByText('db.getCollection("categories").find({ email: <email> }).sort({ createdAt: <number> }).explain("executionStats")')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy the compass command/i })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Collection'), { target: { value: 'cats' } });
    expect(screen.getByText(/db\.getCollection\("cats"\)/)).toBeTruthy();
  });

  it('offers admins a link to enable real values when the app has no key', () => {
    render(<CompassQuery {...base} encryptedSample={null} sampleKeyEnabled={false} canManage />);
    const link = screen.getByRole('link', { name: 'Enable real values in Settings' });
    expect(link.getAttribute('href')).toBe('/dashboard/o/a/settings#samples');
    expect(screen.queryByRole('button', { name: 'Reveal real values' })).toBeNull();
  });

  it('shows no enable link below admin', () => {
    render(<CompassQuery {...base} encryptedSample={null} sampleKeyEnabled={false} canManage={false} />);
    expect(screen.queryByRole('link', { name: /enable real values/i })).toBeNull();
  });

  it('offers Reveal when the app has a key and this query has an encrypted sample', () => {
    render(<CompassQuery {...base} encryptedSample={envelope} sampleKeyEnabled canManage={false} />);
    expect(screen.getByRole('button', { name: 'Reveal real values' })).toBeTruthy();
  });

  it('explains when the app has a key but this query has no encrypted sample yet', () => {
    render(<CompassQuery {...base} encryptedSample={null} sampleKeyEnabled canManage />);
    expect(screen.queryByRole('button', { name: 'Reveal real values' })).toBeNull();
    const note = screen.getByText(/no encrypted sample for this query yet/i).textContent!;
    // Arrival needs both a slower run and an SDK that has the public key.
    expect(note).toMatch(/next slowest run/);
    expect(note).toContain('QA_SAMPLE_KEY');
  });
});
