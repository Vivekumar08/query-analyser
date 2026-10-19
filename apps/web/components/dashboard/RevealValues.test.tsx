// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import {
  encryptSample, generateSampleKeyPair, wrapPrivateKey,
  type EncryptedSample, type WrappedKey,
} from '@query-analyser/contract/runtime';
import { RevealValues } from './RevealValues';

const PASS = 'correct horse battery staple';
const EMAIL = 'alice@example.com';
const OID = '64b7f0c2a1b2c3d4e5f60718';
const PLAINTEXT = JSON.stringify({
  filter: { email: EMAIL, _id: { $oid: OID }, name: { $regex: 'ali', $options: 'i' } },
  sort: { createdAt: -1 },
});

// Real contract crypto: a fresh key pair, wrapped at low iterations (fast tests),
// and a sample encrypted to its public key exactly as the SDK does.
let wrapped: WrappedKey;
let publicKey: string;
let envelope: EncryptedSample;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const pair = await generateSampleKeyPair();
  publicKey = pair.publicKey;
  wrapped = await wrapPrivateKey(pair.privateKey, PASS, 1000);
  envelope = await encryptSample(publicKey, PLAINTEXT);
  fetchMock = vi.fn().mockImplementation(async () => ({
    ok: true, status: 200, json: async () => ({ enabled: true, publicKey, wrapped }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function unlock(passphrase: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Reveal real values' }));
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: passphrase } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
}

/** Every request the component made: URL, method and body, as one string each. */
function requests(): string[] {
  return fetchMock.mock.calls.map(([url, init]) => `${String(url)} ${JSON.stringify(init ?? {})}`);
}

describe('RevealValues', () => {
  it('a correct passphrase shows the real query and the real Compass command, with copy', async () => {
    render(<RevealValues appId="a1" encryptedSample={envelope} collection="users" />);
    unlock(PASS);

    const cmd = await screen.findByText(/db\.getCollection\("users"\)\.find\(/);
    expect(cmd.textContent).toBe(
      `db.getCollection("users").find({ email: "${EMAIL}", _id: ObjectId("${OID}"), name: /ali/i }).sort({ createdAt: -1 }).explain("executionStats")`,
    );
    expect(screen.getByRole('button', { name: /copy the real compass command/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy the real query/i })).toBeTruthy();
    // The decrypted JSON is shown as well.
    expect(document.body.textContent).toContain(`"email": "${EMAIL}"`);
    // The passphrase dialog is gone and its input with it.
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
  });

  it('fetches only the wrapped key, with no passphrase or plaintext in any request', async () => {
    render(<RevealValues appId="a1" encryptedSample={envelope} collection="users" />);
    unlock(PASS);
    await screen.findByText(/ObjectId\(/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/apps/a1/sample-key');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    for (const req of requests()) {
      for (const secret of [PASS, EMAIL, OID, 'ali', PLAINTEXT]) expect(req).not.toContain(secret);
    }
  });

  it('a wrong passphrase says so, shows no values, and clears the input', async () => {
    render(<RevealValues appId="a1" encryptedSample={envelope} collection="users" />);
    unlock('not the right passphrase');

    expect((await screen.findByRole('alert')).textContent).toBe("That passphrase didn't unlock the key.");
    expect((screen.getByLabelText('Passphrase') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain(EMAIL);
    expect(document.body.textContent).not.toContain(OID);
    for (const req of requests()) expect(req).not.toContain('not the right passphrase');
  });

  it('a sample from another key (e.g. before a rotation) gets a clear message', async () => {
    const other = await generateSampleKeyPair();
    const foreign = await encryptSample(other.publicKey, PLAINTEXT);
    render(<RevealValues appId="a1" encryptedSample={foreign} collection="users" />);
    unlock(PASS);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This sample was encrypted with a different key (it may predate a rotation).',
    );
    expect(document.body.textContent).not.toContain(EMAIL);
  });

  it('says so when the key has been disabled since the page loaded', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ enabled: false }) }));
    render(<RevealValues appId="a1" encryptedSample={envelope} collection="users" />);
    unlock(PASS);
    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer enabled/i);
  });

  it('Hide removes the values from the page', async () => {
    render(<RevealValues appId="a1" encryptedSample={envelope} collection="users" />);
    unlock(PASS);
    await screen.findByText(/ObjectId\(/);

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(document.body.textContent).not.toContain(EMAIL);
    expect(document.body.textContent).not.toContain(OID);
    expect(screen.getByRole('button', { name: 'Reveal real values' })).toBeTruthy();
  });

  it('the revealed command follows the collection name', async () => {
    const { rerender } = render(<RevealValues appId="a1" encryptedSample={envelope} collection="users" />);
    unlock(PASS);
    await screen.findByText(/ObjectId\(/);
    rerender(<RevealValues appId="a1" encryptedSample={envelope} collection="people" />);
    expect(screen.getByText(/db\.getCollection\("people"\)/)).toBeTruthy();
  });
});
