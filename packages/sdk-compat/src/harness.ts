import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as mongodb4 from 'mongodb4';
import * as mongodb5 from 'mongodb5';
import * as mongodb6 from 'mongodb6';
import * as mongodb7 from 'mongodb7';
import mongoose6 from 'mongoose6';
import mongoose7 from 'mongoose7';
import mongoose8 from 'mongoose8';
import mongoose9 from 'mongoose9';
import { init } from '../../sdk/src/index.js';

/**
 * Shared plumbing for the compatibility matrix: a real mongod, a fetch stub
 * that records what the SDK would send, and the driver / Mongoose majors
 * under test (each an npm alias, so every major loads its own copy).
 */

/** A real mongod. Defaults to mongodb-memory-server's default binary; pass e.g. '8.0.4' for a specific server. */
export async function startMongo(version?: string): Promise<MongoMemoryServer> {
  return MongoMemoryServer.create(version ? { binary: { version } } : undefined);
}

export type SentItem = Record<string, unknown> & {
  model: string;
  collection: string;
  operation: string;
  count: number;
  filterShape: unknown;
  source: string;
};

/**
 * A fetchImpl that records each request body (gunzipped when the transport
 * compressed it, as in the SDK integration test) and answers 202.
 */
export function capture(): { fetchImpl: typeof fetch; items(): SentItem[]; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, req?: RequestInit) => {
    const isGzipped = (req?.headers as Record<string, string> | undefined)?.['Content-Encoding'] === 'gzip';
    const body = req?.body;
    if (isGzipped && body) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as unknown as Uint8Array);
      bodies.push(gunzipSync(buf).toString('utf8'));
    } else {
      bodies.push(typeof body === 'string' ? body : String(body));
    }
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
  const items = (): SentItem[] => bodies.flatMap((b) => (JSON.parse(b) as { items: SentItem[] }).items);
  return { fetchImpl, items, bodies };
}

type Driver = typeof import('mongodb7');
type Mongoose = typeof import('mongoose8');

// Typed against driver 7 / Mongoose 8 so the tests are written once; each
// entry still runs its own major at runtime.
export const DRIVERS: { major: 4 | 5 | 6 | 7; alias: string; mod: Driver }[] = [
  { major: 4, alias: 'mongodb4', mod: mongodb4 as unknown as Driver },
  { major: 5, alias: 'mongodb5', mod: mongodb5 as unknown as Driver },
  { major: 6, alias: 'mongodb6', mod: mongodb6 as unknown as Driver },
  { major: 7, alias: 'mongodb7', mod: mongodb7 },
];

// Mongoose 6 prints a strictQuery DeprecationWarning until the option is set.
// `true` is Mongoose 6's own default, so behaviour under test is unchanged.
mongoose6.set('strictQuery', true);

export const MONGOOSES: { major: 6 | 7 | 8 | 9; alias: string; mod: Mongoose }[] = [
  { major: 6, alias: 'mongoose6', mod: mongoose6 },
  { major: 7, alias: 'mongoose7', mod: mongoose7 },
  { major: 8, alias: 'mongoose8', mod: mongoose8 },
  { major: 9, alias: 'mongoose9', mod: mongoose9 },
];

const require = createRequire(import.meta.url);
const majorOf = (version: string): number => Number(version.split('.')[0]);

/**
 * The major of an installed alias, read from its own package.json, and
 * whether `mod` is the copy that alias loads. Catches an alias that
 * resolves to the wrong major, or a row wired to the wrong module.
 */
export function loadedDriver(alias: string, mod: { MongoClient: unknown }): { major: number; same: boolean } {
  const pkg = require(`${alias}/package.json`) as { version: string };
  const own = require(alias) as { MongoClient: unknown };
  return { major: majorOf(pkg.version), same: own.MongoClient === mod.MongoClient };
}

/**
 * The `mongodb` a Mongoose alias resolves from its own install (the driver it
 * bundles), and whether it is the driver that Mongoose actually uses, via its
 * public `mongoose.mongo`.
 */
export function bundledDriver(alias: string, mod: { mongo: { MongoClient: unknown } }): { major: number; same: boolean } {
  const fromMongoose = createRequire(require.resolve(`${alias}/package.json`));
  const pkg = fromMongoose('mongodb/package.json') as { version: string };
  const driver = fromMongoose('mongodb') as { MongoClient: unknown };
  return { major: majorOf(pkg.version), same: driver.MongoClient === mod.mongo.MongoClient };
}

/** A unique suffix, so model and collection names never collide across tests. */
export const suffix = (): string => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// Type-only checks (never called): the SDK's structural types accept a
// driver 7 client and a Mongoose 9 instance.
function typeChecks(): void {
  init({ apiKey: 'k', app: 'x', mongoClient: new mongodb7.MongoClient('mongodb://x') });
  init({ apiKey: 'k', app: 'x', mongoose: mongoose9 });
}
void typeChecks;
