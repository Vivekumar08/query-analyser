// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const crypto = vi.hoisted(() => ({
  generateSampleKeyPair: vi.fn(),
  wrapPrivateKey: vi.fn(),
}));
vi.mock('@query-analyser/contract/runtime', () => crypto);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { SampleKeySection } from './SampleKeySection';

const PASS = 'correct horse battery staple';
const wrapped = { v: 1, salt: 'c2FsdA==', iv: 'aXY=', iterations: 600000, ciphertext: 'Y3Q=' };
const privateKey = { type: 'private' } as unknown as CryptoKey;

function typePassphrase(p = PASS, confirm = p) {
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: p } });
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: confirm } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  crypto.generateSampleKeyPair.mockReset().mockResolvedValue({ publicKey: 'TkVXUFVC', privateKey });
  crypto.wrapPrivateKey.mockReset().mockResolvedValue(wrapped);
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ enabled: true, publicKey: 'TkVXUFVC' }) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SampleKeySection (admin)', () => {
  it('Enable with a valid passphrase PUTs only the public key and wrap, then shows the env line with Copy', async () => {
    render(<SampleKeySection appId="a1" canManage initial={{ enabled: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    expect(screen.getByText(/If you lose this passphrase, stored values cannot be recovered\./)).toBeTruthy();
    typePassphrase();
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }));

    await screen.findByText('QA_SAMPLE_KEY=TkVXUFVC');
    expect(screen.getByRole('button', { name: /copy the sample key env line/i })).toBeTruthy();

    // The passphrase only ever reaches the in-browser wrap.
    expect(crypto.wrapPrivateKey).toHaveBeenCalledWith(privateKey, PASS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/apps/a1/sample-key');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(init.body).not.toContain('passphrase');
    expect(init.body).not.toContain(PASS);
    expect(JSON.parse(init.body)).toEqual({ publicKey: 'TkVXUFVC', wrapped });
    // The inputs are gone once the key is set.
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
  });

  it('a short or mismatched passphrase blocks the request and says why', () => {
    render(<SampleKeySection appId="a1" canManage initial={{ enabled: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    typePassphrase('too short', 'too short');
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }));
    expect(screen.getByRole('alert').textContent).toMatch(/12 characters/);
    typePassphrase(PASS, `${PASS}x`);
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }));
    expect(screen.getByRole('alert').textContent).toMatch(/don.t match/);
    expect(crypto.generateSampleKeyPair).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the API error when the PUT fails, and keeps the key disabled', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Only workspace admins can change this.' }) });
    render(<SampleKeySection appId="a1" canManage initial={{ enabled: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    typePassphrase();
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Only workspace admins can change this.');
    expect(screen.queryByText(/QA_SAMPLE_KEY=/)).toBeNull();
  });

  it('Rotate warns that stored values will be cleared before asking for a passphrase', async () => {
    render(<SampleKeySection appId="a1" canManage initial={{ enabled: true, publicKey: 'T0xE' }} />);
    expect(screen.getByText('QA_SAMPLE_KEY=T0xE')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    expect(screen.getByText(/clears every stored encrypted sample for this app/i)).toBeTruthy();
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));
    typePassphrase();
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }));
    await screen.findByText('QA_SAMPLE_KEY=TkVXUFVC');
    expect(fetchMock.mock.calls[0]![1].method).toBe('PUT');
  });

  it('Disable warns, then DELETEs and shows the disabled state', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
    render(<SampleKeySection appId="a1" canManage initial={{ enabled: true, publicKey: 'T0xE' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    expect(screen.getByText(/clears every stored encrypted sample for this app/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disable encrypted samples' }));
    await screen.findByRole('button', { name: 'Enable' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/apps/a1/sample-key');
    expect(init.method).toBe('DELETE');
    expect(screen.queryByText(/QA_SAMPLE_KEY=/)).toBeNull();
  });

  it('a 401 sends the user through /api/auth/refresh back to this page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/dashboard/o/a/settings', search: '', hash: '#samples', assign });
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    render(<SampleKeySection appId="a1" canManage initial={{ enabled: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    typePassphrase();
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign).toHaveBeenCalledWith('/api/auth/refresh?next=' + encodeURIComponent('/dashboard/o/a/settings'));
  });
});

describe('SampleKeySection (below admin)', () => {
  it('sees the status only, with no buttons', () => {
    render(<SampleKeySection appId="a1" canManage={false} initial={{ enabled: true, publicKey: 'T0xE' }} />);
    expect(screen.getByText(/enabled/i)).toBeTruthy();
    expect(screen.queryByText(/QA_SAMPLE_KEY=/)).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    cleanup();
    render(<SampleKeySection appId="a1" canManage={false} initial={{ enabled: false }} />);
    expect(screen.getByText(/not enabled/i)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/ask an admin/i)).toBeTruthy();
  });
});
