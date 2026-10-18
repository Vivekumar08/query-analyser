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
