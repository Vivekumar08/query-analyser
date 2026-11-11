import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { init, shutdown } from './index.js';

// Neither peer is reachable: the SDK copy was bundled, or installed without them.
vi.mock('./drivers.js', async (orig) => ({ ...(await orig<typeof import('./drivers.js')>()), resolvePeer: () => null }));

const okFetch = () => Promise.resolve(new Response('{}', { status: 202 }));
afterEach(async () => { await shutdown(); });

describe('init() with no resolvable driver', () => {
  it('warns once when neither mongoose nor mongodb can be resolved and no mongoClient is given', () => {
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      'query-analyser: neither mongoose nor mongodb could be resolved and no mongoClient was given; pass init({ mongoose }) or init({ mongoClient })',
    );
  });

  it('does not warn when a mongoClient is given', () => {
    const onError = vi.fn();
    const client = Object.assign(new EventEmitter(), { options: { monitorCommands: true } });
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError, mongoClient: client });
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not warn when mongoose is passed in', () => {
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError, mongoose: { connections: [] } });
    expect(onError).not.toHaveBeenCalled();
  });
});
