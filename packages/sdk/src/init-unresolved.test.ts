import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { init, shutdown } from './index.js';

// No peer is reachable: the SDK copy was bundled, or installed without them. Every resolver is
// injected (never relaxed because pnpm's NODE_PATH would otherwise find a workspace copy).
const peers = vi.hoisted(() => ({
  pg: { clients: [] as Function[], pools: [] as Function[], adapterResolved: false },
  prismaPath: null as string | null,
}));
vi.mock('./drivers.js', async (orig) => ({
  ...(await orig<typeof import('./drivers.js')>()),
  resolvePeer: () => null,
  resolvePgClients: () => ({ ...peers.pg }),
  resolveAppPath: () => peers.prismaPath,
}));

const okFetch = () => Promise.resolve(new Response('{}', { status: 202 }));
afterEach(async () => {
  await shutdown();
  peers.pg = { clients: [], pools: [], adapterResolved: false };
  peers.prismaPath = null;
});

describe('init() with no resolvable driver', () => {
  it('warns once when none of mongoose, mongodb, pg or @prisma/client can be resolved and no client is given', () => {
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      'query-analyser: none of mongoose, mongodb, pg or @prisma/client could be resolved and no client was given; pass init({ mongoose }), init({ mongoClient }) or init({ pg })',
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

  it('does not warn when pg resolves', () => {
    class Client { query() {} }
    peers.pg = { clients: [Client], pools: [], adapterResolved: false };
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError });
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not warn when pg is passed in', () => {
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError, pg: {} });
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not warn when @prisma/client resolves from the app', () => {
    peers.prismaPath = '/app/node_modules/@prisma/client/default.js';
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError });
    expect(onError).not.toHaveBeenCalled();
  });
});
