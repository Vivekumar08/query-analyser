import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { init, shutdown } from './index.js';

afterEach(async () => { await shutdown(); });

const okFetch = () => Promise.resolve(new Response('{}', { status: 202 }));

describe('init', () => {
  it('requires an apiKey and an app name', () => {
    expect(() => init({ apiKey: '', app: 'x' })).toThrow(/apiKey/);
    expect(() => init({ apiKey: 'k', app: '' })).toThrow(/app/);
  });

  it('instruments models compiled BEFORE init was called', () => {
    const m = mongoose;
    m.model(`BeforeInit_${Date.now()}`, new mongoose.Schema({ a: String }));
    const a = init({ apiKey: 'k', app: 'x', mongoose: m, fetchImpl: okFetch });
    expect(a.installedModels).toBeGreaterThan(0);
  });

  it('instruments models compiled AFTER init via the global plugin', () => {
    const m = mongoose;
    init({ apiKey: 'k', app: 'x', mongoose: m, fetchImpl: okFetch });
    const schema = new mongoose.Schema({ a: String });
    m.model(`AfterInit_${Date.now()}`, schema);
    // The global plugin ran, so the install marker is on the schema.
    expect(Object.getOwnPropertySymbols(schema).some((s) => String(s).includes('query-analyser')))
      .toBe(true);
  });

  it('does nothing at all when disabled', () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', enabled: false, mongoose, fetchImpl });
    expect(a.installedModels).toBe(0);
  });

  it('sends nothing when the window is empty', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    await a.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Controller Ruling B: the brief's "stops sending after the server rejects
  // the key" test flushes an empty buffer, so flush() returns before calling
  // fetch and the assertion passes vacuously. Dropped here; the disable latch
  // is asserted in Task 9's integration test where real queries produce real
  // content.
});
