import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

export function createPrisma(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

let singleton: PrismaClient | null = null;
export function getPrisma(connectionString: string): PrismaClient {
  singleton ??= createPrisma(connectionString);
  return singleton;
}

export type { PrismaClient };
export { Role, AdviceStatus } from './generated/prisma/enums.js';
