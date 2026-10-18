/**
 * End-to-end sample encryption shared by the SDK (encrypts) and the browser
 * (decrypts). The server only ever stores the public key, the passphrase-
 * wrapped private key and opaque envelopes, so it can never read a value.
 *
 * Web Crypto only (`globalThis.crypto`): no `node:crypto`, no Buffer, no
 * dependencies — the published SDK inlines this module.
 *
 * - Key pair: ECDH P-256.
 * - Envelope (ECIES): a fresh ephemeral P-256 key per encryption; ECDH shared
 *   secret -> HKDF-SHA-256 (empty salt, info "qa-sample-v1") -> non-extractable
 *   AES-256-GCM key; fresh random 12-byte IV; additional data binds the
 *   version label and the ephemeral public key.
 * - Private key at rest: PKCS8 encrypted with AES-256-GCM under a
 *   PBKDF2-SHA-256 key (600 000 iterations by default, 16-byte random salt,
 *   fresh 12-byte IV).
 */

export type SampleKeyErrorCode = 'wrong-passphrase' | 'undecryptable' | 'invalid-public-key';

const MESSAGES: Record<SampleKeyErrorCode, string> = {
  'wrong-passphrase': "That passphrase didn't unlock the key.",
  undecryptable: 'This sample could not be decrypted with the current key.',
  'invalid-public-key': 'The sample public key is not a valid P-256 key.',
};

/** Error with a fixed, key-free message per code. Never carries key material. */
export class SampleKeyError extends Error {
  readonly code: SampleKeyErrorCode;

  constructor(code: SampleKeyErrorCode) {
    super(MESSAGES[code]);
    this.name = 'SampleKeyError';
    this.code = code;
  }
}

export interface WrappedKey {
  v: 1;
  salt: string;
  iv: string;
  iterations: number;
  ciphertext: string;
}

export interface EncryptedSample {
  v: 1;
  /** Ephemeral P-256 public key, raw uncompressed point, base64. */
  epk: string;
  iv: string;
  ct: string;
}

export const SAMPLE_KEY_DEFAULT_ITERATIONS = 600_000;

const INFO = 'qa-sample-v1';
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const IV_BYTES = 12;
const SALT_BYTES = 16;
/** Upper bound on stored iterations so a tampered record cannot hang the browser. */
const MAX_ITERATIONS = 10_000_000;

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Strict standard base64 decode; throws on anything else. */
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error('invalid base64');
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** GCM additional data: the version label followed by the ephemeral public key. */
function envelopeAad(epkRaw: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(encoder.encode(INFO), epkRaw);
}

export async function generateSampleKeyPair(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  // Extractable so the private key can be exported as PKCS8 and wrapped.
  const pair = await subtle().generateKey(CURVE, true, ['deriveBits']);
  const spki = await subtle().exportKey('spki', pair.publicKey);
  return { publicKey: toBase64(spki), privateKey: pair.privateKey };
}

async function passphraseKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function wrapPrivateKey(
  privateKey: CryptoKey,
  passphrase: string,
  iterations: number = SAMPLE_KEY_DEFAULT_ITERATIONS,
): Promise<WrappedKey> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new RangeError('iterations must be an integer between 1 and 10 000 000');
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kek = await passphraseKey(passphrase, salt, iterations, 'encrypt');
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', privateKey));
  try {
    const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, kek, pkcs8);
    return { v: 1, salt: toBase64(salt), iv: toBase64(iv), iterations, ciphertext: toBase64(ciphertext) };
  } finally {
    pkcs8.fill(0);
  }
}

/**
 * Returns a non-extractable ECDH private key. Any failure — wrong passphrase,
 * corrupted record, unknown version — is `wrong-passphrase`: GCM cannot tell
 * them apart, and the message never echoes the input.
 */
export async function unwrapPrivateKey(wrapped: WrappedKey, passphrase: string): Promise<CryptoKey> {
  let pkcs8: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (wrapped?.v !== 1) throw new Error('version');
    const { iterations } = wrapped;
    if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
      throw new Error('iterations');
    }
    const salt = fromBase64(wrapped.salt);
    const iv = fromBase64(wrapped.iv);
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) throw new Error('lengths');
    const kek = await passphraseKey(passphrase, salt, iterations, 'decrypt');
    pkcs8 = new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv }, kek, fromBase64(wrapped.ciphertext)),
    );
    return await subtle().importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']);
  } catch {
    throw new SampleKeyError('wrong-passphrase');
  } finally {
    pkcs8?.fill(0);
  }
}

export async function importSamplePublicKey(spkiB64: string): Promise<CryptoKey> {
  try {
    return await subtle().importKey('spki', fromBase64(spkiB64), CURVE, true, []);
  } catch {
    throw new SampleKeyError('invalid-public-key');
  }
}

/** ECDH shared secret -> HKDF-SHA-256 -> non-extractable AES-256-GCM key. */
async function envelopeKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptSample(
  publicKeySpkiB64: string,
  plaintext: string,
): Promise<EncryptedSample> {
  const recipient = await importSamplePublicKey(publicKeySpkiB64);
  // Fresh ephemeral key per envelope; it never leaves this function.
  const ephemeral = await subtle().generateKey(CURVE, false, ['deriveBits']);
  const epkRaw = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
  const key = await envelopeKey(ephemeral.privateKey, recipient, 'encrypt');
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: envelopeAad(epkRaw) },
    key,
    encoder.encode(plaintext),
  );
  return { v: 1, epk: toBase64(epkRaw), iv: toBase64(iv), ct: toBase64(ct) };
}

/** Any failure — tampering, another key, malformed envelope — is `undecryptable`. */
export async function decryptSample(privateKey: CryptoKey, env: EncryptedSample): Promise<string> {
  try {
    if (env?.v !== 1) throw new Error('version');
    const epkRaw = fromBase64(env.epk);
    const iv = fromBase64(env.iv);
    if (iv.length !== IV_BYTES) throw new Error('iv');
    const epk = await subtle().importKey('raw', epkRaw, CURVE, false, []);
    const key = await envelopeKey(privateKey, epk, 'decrypt');
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: envelopeAad(epkRaw) },
      key,
      fromBase64(env.ct),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    throw new SampleKeyError('undecryptable');
  }
}
