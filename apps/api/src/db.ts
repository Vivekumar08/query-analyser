import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

export function createPrisma(connectionString: string): PrismaClient {
  // `@prisma/adapter-pg`'s timestamptz normalizer relabels whatever offset
  // Postgres sends back as "+00:00" instead of actually converting to UTC
  // (see normalize_timestamptz in its dist bundle). On a server whose session
  // timezone isn't already UTC, that silently shifts every DateTime read
  // through this adapter by the session's UTC offset. Force the session
  // timezone to UTC on every connection in the pool so raw-query timestamps
  // (e.g. bucketHour round-trips) and model DateTime fields are correct, not
  // just self-consistent.
  //
  // This is now belt-and-braces, not the only defence: every DateTime
  // column in prisma/schema.prisma is `@db.Timestamptz(3)`, so the columns
  // themselves store real instants and are immune to session-timezone drift
  // even if a future connection (a transaction-mode pooler, a managed
  // Postgres that resets session state, or code that opens its own
  // connection) doesn't carry this option.
  const adapter = new PrismaPg({ connectionString, options: '-c timezone=UTC' });
  return new PrismaClient({ adapter });
}

let singleton: PrismaClient | null = null;
export function getPrisma(connectionString: string): PrismaClient {
  singleton ??= createPrisma(connectionString);
  return singleton;
}

export type { PrismaClient };
export { Role, AdviceStatus } from './generated/prisma/enums.js';
