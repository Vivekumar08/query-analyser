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
