import { describe, it, expect } from 'vitest';
import { ingestPayloadSchema } from './schema.js';

const item = {
  signature: 'Order.find(status:eq)',
  hash: 'a1b2c3d4e5f60718',
  model: 'Order',
  operation: 'find',
  filterShape: [{ key: 'status', op: 'eq' }],
  sortKeys: [{ key: 'createdAt', dir: -1 }],
  stages: [],
  count: 3,
  totalMs: 600,
  maxMs: 400,
  lastMs: 120,
  lastTs: 1758378000000,
  hist: [1, 1, 0, 1, 0, 0, 0, 0],
  sample: { status: '<string>' },
};

const payload = {
  app: 'kisna-web',
  env: 'production',
  host: 'web-7d9f',
  sdkVersion: '0.1.0',
  bucket: '2026092014',
  thresholdMs: 100,
  dropped: 0,
  items: [item],
};

describe('ingestPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(ingestPayloadSchema.parse(payload)).toMatchObject({ app: 'kisna-web' });
  });

  it('rejects a histogram that is not exactly 8 buckets', () => {
    const bad = { ...payload, items: [{ ...item, hist: [1, 2, 3] }] };
    expect(() => ingestPayloadSchema.parse(bad)).toThrow();
  });

  it('rejects a malformed bucket string', () => {
    expect(() => ingestPayloadSchema.parse({ ...payload, bucket: '2026-09-20' })).toThrow();
  });

  it('rejects an unknown operator class', () => {
    const bad = { ...payload, items: [{ ...item, filterShape: [{ key: 'x', op: 'wat' }] }] };
    expect(() => ingestPayloadSchema.parse(bad)).toThrow();
  });

  it('rejects a batch larger than the cap', () => {
    const bad = { ...payload, items: Array.from({ length: 5001 }, () => item) };
    expect(() => ingestPayloadSchema.parse(bad)).toThrow();
  });

  it('rejects an app name that is empty', () => {
    expect(() => ingestPayloadSchema.parse({ ...payload, app: '' })).toThrow();
  });
});

describe('ingest item encryptedSample', () => {
  const env = { v: 1, epk: 'B'.repeat(88), iv: 'A'.repeat(16), ct: 'C'.repeat(1000) };
  const withSample = (encryptedSample: unknown) => ({ ...payload, items: [{ ...item, encryptedSample }] });

  it('accepts an item with no encryptedSample at all', () => {
    const parsed = ingestPayloadSchema.parse(payload);
    expect('encryptedSample' in parsed.items[0]!).toBe(false);
  });

  it('accepts a null encryptedSample', () => {
    expect(ingestPayloadSchema.parse(withSample(null)).items[0]!.encryptedSample).toBeNull();
  });

  it('accepts a well-formed envelope', () => {
    expect(ingestPayloadSchema.parse(withSample(env)).items[0]!.encryptedSample).toEqual(env);
  });

  it('accepts a ct of exactly 24 000 chars', () => {
    expect(() => ingestPayloadSchema.parse(withSample({ ...env, ct: 'C'.repeat(24_000) }))).not.toThrow();
  });

  it('rejects a ct over 24 000 chars', () => {
    expect(() => ingestPayloadSchema.parse(withSample({ ...env, ct: 'C'.repeat(24_001) }))).toThrow();
  });

  it('rejects an epk over 200 chars', () => {
    expect(() => ingestPayloadSchema.parse(withSample({ ...env, epk: 'B'.repeat(201) }))).toThrow();
  });

  it('rejects an iv over 32 chars', () => {
    expect(() => ingestPayloadSchema.parse(withSample({ ...env, iv: 'A'.repeat(33) }))).toThrow();
  });

  it('rejects an envelope of another version', () => {
    expect(() => ingestPayloadSchema.parse(withSample({ ...env, v: 2 }))).toThrow();
  });
});
