import { describe, expect, it } from 'vitest';
import {
  SampleKeyError,
  decryptSample,
  encryptSample,
  generateSampleKeyPair,
  importSamplePublicKey,
  unwrapPrivateKey,
  wrapPrivateKey,
  type EncryptedSample,
  type WrappedKey,
} from './sample-crypto.js';

// Low iteration count keeps the suite fast; the default is pinned separately.
const FAST = 1_000;
const PASSPHRASE = 'correct horse battery staple';
const SAMPLE = '{"filter":{"email":"a@b.c"}}';

async function expectCode(p: Promise<unknown>, code: SampleKeyError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SampleKeyError);
  expect((err as SampleKeyError).code).toBe(code);
  return err as SampleKeyError;
}

/** Flip one base64 character to a different valid base64 character. */
function flipChar(b64: string, at: number): string {
  const c = b64[at];
  const replacement = c === 'A' ? 'B' : 'A';
  return b64.slice(0, at) + replacement + b64.slice(at + 1);
}

describe('sample crypto', () => {
  it('round trip: wrap, unwrap, encrypt and decrypt exactly', async () => {
    const { publicKey, privateKey } = await generateSampleKeyPair();
    const wrapped = await wrapPrivateKey(privateKey, PASSPHRASE, FAST);
    expect(wrapped.v).toBe(1);
    expect(wrapped.iterations).toBe(FAST);

    const unwrapped = await unwrapPrivateKey(wrapped, PASSPHRASE);
    expect(unwrapped.extractable).toBe(false);

    const env = await encryptSample(publicKey, SAMPLE);
    expect(env.v).toBe(1);
    expect(env.ct).not.toContain('email');
    expect(await decryptSample(unwrapped, env)).toBe(SAMPLE);
  });

  it('round trips non-ASCII text', async () => {
    const { publicKey, privateKey } = await generateSampleKeyPair();
    const text = '{"name":"Zoë 名前 🚀"}';
    expect(await decryptSample(privateKey, await encryptSample(publicKey, text))).toBe(text);
  });

  it('rejects wrong passphrase', async () => {
    const { privateKey } = await generateSampleKeyPair();
    const wrapped = await wrapPrivateKey(privateKey, PASSPHRASE, FAST);
    const err = await expectCode(unwrapPrivateKey(wrapped, 'not the passphrase'), 'wrong-passphrase');
    expect(err.message).not.toContain('not the passphrase');
    expect(err.message).not.toContain(wrapped.ciphertext);
  });

  it('rejects a corrupted wrapped key as wrong-passphrase', async () => {
    const { privateKey } = await generateSampleKeyPair();
    const wrapped = await wrapPrivateKey(privateKey, PASSPHRASE, FAST);
    await expectCode(
      unwrapPrivateKey({ ...wrapped, ciphertext: flipChar(wrapped.ciphertext, 10) }, PASSPHRASE),
      'wrong-passphrase',
    );
    await expectCode(unwrapPrivateKey({ ...wrapped, salt: '***' }, PASSPHRASE), 'wrong-passphrase');
    await expectCode(unwrapPrivateKey({ ...wrapped, iterations: 0 }, PASSPHRASE), 'wrong-passphrase');
  });

  it('rejects tampered ciphertext', async () => {
    const { publicKey, privateKey } = await generateSampleKeyPair();
    const env = await encryptSample(publicKey, SAMPLE);
    await expectCode(decryptSample(privateKey, { ...env, ct: flipChar(env.ct, 3) }), 'undecryptable');
    await expectCode(decryptSample(privateKey, { ...env, iv: flipChar(env.iv, 0) }), 'undecryptable');
    await expectCode(decryptSample(privateKey, { ...env, ct: 'not base64!' }), 'undecryptable');
    await expectCode(decryptSample(privateKey, { ...env, epk: 'AAAA' }), 'undecryptable');
    await expectCode(
      decryptSample(privateKey, { ...env, v: 2 } as unknown as EncryptedSample),
      'undecryptable',
    );
  });

  it('rejects envelope from another key', async () => {
    const a = await generateSampleKeyPair();
    const b = await generateSampleKeyPair();
    const env = await encryptSample(a.publicKey, SAMPLE);
    await expectCode(decryptSample(b.privateKey, env), 'undecryptable');
  });

  it('binds the ephemeral public key: swapping epk fails', async () => {
    const { publicKey, privateKey } = await generateSampleKeyPair();
    const one = await encryptSample(publicKey, SAMPLE);
    const two = await encryptSample(publicKey, SAMPLE);
    await expectCode(decryptSample(privateKey, { ...one, epk: two.epk }), 'undecryptable');
  });

  it('uses a fresh ephemeral key and IV per encryption', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const one = await encryptSample(publicKey, SAMPLE);
    const two = await encryptSample(publicKey, SAMPLE);
    expect(one.epk).not.toBe(two.epk);
    expect(one.iv).not.toBe(two.iv);
    expect(one.ct).not.toBe(two.ct);
  });

  it('keeps output sizes within the contract caps', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const env = await encryptSample(publicKey, SAMPLE);
    expect(env.epk.length).toBeLessThanOrEqual(200);
    expect(env.iv.length).toBeLessThanOrEqual(32);
    // 16 KiB plaintext fits the 24 000-char ct cap.
    const big = await encryptSample(publicKey, 'x'.repeat(16_384));
    expect(big.ct.length).toBeLessThanOrEqual(24_000);
  });

  it('rejects an invalid public key', async () => {
    await expectCode(importSamplePublicKey('nope'), 'invalid-public-key');
    await expectCode(importSamplePublicKey(''), 'invalid-public-key');
    await expectCode(encryptSample('nope', SAMPLE), 'invalid-public-key');
  });

  it('imports a generated public key', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const key = await importSamplePublicKey(publicKey);
    expect(key.type).toBe('public');
  });

  it('defaults to exactly 600 000 PBKDF2 iterations', { timeout: 5_000 }, async () => {
    const { privateKey } = await generateSampleKeyPair();
    const wrapped = await wrapPrivateKey(privateKey, PASSPHRASE);
    expect(wrapped.iterations).toBe(600_000);
    expect(await unwrapPrivateKey(wrapped, PASSPHRASE)).toBeTruthy();
  });

  it('uses 16-byte salts and 12-byte IVs', async () => {
    const { publicKey, privateKey } = await generateSampleKeyPair();
    const wrapped = await wrapPrivateKey(privateKey, PASSPHRASE, FAST);
    expect(atob(wrapped.salt)).toHaveLength(16);
    expect(atob(wrapped.iv)).toHaveLength(12);
    const env = await encryptSample(publicKey, SAMPLE);
    expect(atob(env.iv)).toHaveLength(12);
    expect(atob(env.epk)).toHaveLength(65); // uncompressed raw P-256 point
  });
});

describe('sample crypto: passphrase normalisation', () => {
  it('unwraps with the NFD form of an NFC passphrase', async () => {
    const { privateKey } = await generateSampleKeyPair();
    const wrapped = await wrapPrivateKey(privateKey, 'mot de passe café!', FAST);
    expect(await unwrapPrivateKey(wrapped, 'mot de passe café!')).toBeTruthy();
  });
});

/**
 * Committed wire-format vectors, produced once by this implementation.
 * Any change to HKDF info/salt, AAD, IV handling, PBKDF2 parameters or the
 * PKCS8 wrap layout breaks these — envelopes already stored would no longer
 * decrypt, so such a change needs a new envelope version, not an edit here.
 */
describe('sample crypto: fixed test vectors', () => {
  const VECTOR_PLAINTEXT = '{"filter":{"email":"a@b.c"}}';
  const VECTOR_PASSPHRASE = 'vector passphrase café';
  const VECTOR_PUBLIC_SPKI =
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE0sRzWmOPfIwDxkzs/uVqdh4yeAWyIN16XyYIOaNDrvb5EJAawtoCMTKbuke1nQdQnkIF/qqtrDFL968fliHqDA==';
  // Test-only key. Never use outside this file.
  const VECTOR_PRIVATE_PKCS8 =
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgzXC3/kCu3PA086a8jkiQbV6MElVexmB/TIzx4/e414WhRANCAATSxHNaY498jAPGTOz+5Wp2HjJ4BbIg3XpfJgg5o0Ou9vkQkBrC2gIxMpu6R7WdB1CeQgX+qq2sMUv3rx+WIeoM';
  const VECTOR_ENVELOPE: EncryptedSample = {
    v: 1,
    epk: 'BII/sPAHlpnsLEY5t2HroennaX+nFT55ZoutNmTB28PSq31GXn5C0O5iwZ3Ws+lj0D1d4ROD7CxSMEfcW3wTjnQ=',
    iv: 'lFiWBFSKcfzD+Ss2',
    ct: 'xB4Rx6NpIkDYh4cUcX9Uvzs8SME2uMJYZjGdd2mMiBtogkTFLaVm8QihKys=',
  };
  const VECTOR_WRAPPED: WrappedKey = {
    v: 1,
    salt: '/M8x7ZvJ1XCcClb0c6X+5Q==',
    iv: 'evZbgANI/WV1+aum',
    iterations: 1000,
    ciphertext:
      '9kA9EjUECYoaEAl0aHGm+xIef33EJ89U/qdEnoyRQTid3fPVj17ws/GxiRWdguwIyk7zVABm3yfCuqz1exg7NqpNBskeDlxq+2K/joTKTY3gLtB0184kPxNF6S6FPAz5hyxu/hFHD8RIq5HmKwp01geZrsvK3FBDyXcQAc0hdwcpZBmfW7rcFtdxzPUYQsRdVeW3+JXhkcZTzg==',
  };

  async function importVectorPrivate() {
    const der = Uint8Array.from(atob(VECTOR_PRIVATE_PKCS8), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('pkcs8', der, { name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ]);
  }

  it('decrypts the committed envelope with the committed private key', async () => {
    expect(await decryptSample(await importVectorPrivate(), VECTOR_ENVELOPE)).toBe(VECTOR_PLAINTEXT);
  });

  it('the committed public key imports', async () => {
    expect((await importSamplePublicKey(VECTOR_PUBLIC_SPKI)).type).toBe('public');
  });

  it('unwraps the committed wrapped key and decrypts the committed envelope', async () => {
    const key = await unwrapPrivateKey(VECTOR_WRAPPED, VECTOR_PASSPHRASE);
    expect(await decryptSample(key, VECTOR_ENVELOPE)).toBe(VECTOR_PLAINTEXT);
  });

  it('unwraps the committed wrapped key with the NFD form of its passphrase', async () => {
    expect(await unwrapPrivateKey(VECTOR_WRAPPED, 'vector passphrase cafe\u0301')).toBeTruthy();
  });

  it('rejects the committed wrapped key under another passphrase', async () => {
    await expectCode(unwrapPrivateKey(VECTOR_WRAPPED, 'vector passphrase cafe'), 'wrong-passphrase');
  });
});
