/**
 * Mongoose 5.13 (driver 3.7) is best effort: this smoke test is the only
 * guarantee. Driver 3 has no public way to switch command monitoring on or
 * to tell whether it is on, so the SDK neither enables it nor warns; the app
 * must pass `monitorCommands: true` in its connect options.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose5 from 'mongoose5';
import { init, shutdown } from '../../sdk/src/index.js';
import { bundledDriver, capture, startMongo } from './harness.js';

describe('mongoose 5 (best effort)', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await startMongo();
  });
  afterAll(async () => {
    await mongod.stop();
  });
  afterEach(async () => {
    await mongoose5.disconnect();
    await shutdown();
  });

  it('mongoose 5 with monitorCommands: true reports a find under its model name', async () => {
    expect(mongoose5.version.startsWith('5.'), mongoose5.version).toBe(true);
    expect(bundledDriver('mongoose5', mongoose5)).toEqual({ major: 3, same: true });
    const { fetchImpl, items } = capture();
    const a = init({ apiKey: 'k', app: 'compat-mongoose5', mongoose: mongoose5, thresholdMs: 0, fetchImpl, onError: () => {} });
    // Typed against the Mongoose 8 shim, which has no useNewUrlParser /
    // useUnifiedTopology: these are Mongoose 5's own connect options.
    await mongoose5.connect(mongod.getUri(), { monitorCommands: true, useNewUrlParser: true, useUnifiedTopology: true } as Parameters<typeof mongoose5.connect>[1]);

    const Smoke = mongoose5.model('Smoke', new mongoose5.Schema({ a: Number }));
    await Smoke.find({ a: 1 }).exec();
    await a.flush();

    expect(items()).toContainEqual(expect.objectContaining({ model: 'Smoke', operation: 'find', collection: 'smokes' }));
  });
});
