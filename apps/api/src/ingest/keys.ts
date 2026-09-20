import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '../db.js';

const PREFIX = 'qa_live_';

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateKey(): { key: string; hash: string; prefix: string } {
  const key = PREFIX + randomBytes(16).toString('hex');
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) };
}

export interface ResolvedKey {
  keyId: string;
  appId: string;
  orgId: string;
  suspended: boolean;
}

interface CacheEntry { value: ResolvedKey | null; expiresAt: number }

export class KeyResolver {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaClient, private readonly ttlMs = 60_000) {}

  async resolve(key: string): Promise<ResolvedKey | null> {
    if (!key.startsWith(PREFIX)) return null;
    const hash = hashKey(key);
    const hit = this.cache.get(hash);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const row = await this.prisma.ingestKey.findUnique({
      where: { keyHash: hash },
      select: { id: true, revokedAt: true, app: { select: { id: true, orgId: true, org: { select: { suspendedAt: true } } } } },
    });

    const value: ResolvedKey | null = row && !row.revokedAt
      ? { keyId: row.id, appId: row.app.id, orgId: row.app.orgId, suspended: row.app.org.suspendedAt !== null }
      : null;

    this.cache.set(hash, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  invalidate(hash: string): void {
    this.cache.delete(hash);
  }
}
