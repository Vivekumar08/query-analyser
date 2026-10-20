import { Prisma } from './generated/prisma/client.js';

/**
 * True when `err` is Postgres refusing a write for a missing referenced row
 * (SQLSTATE 23503), e.g. writing for an app or signature deleted meanwhile.
 *
 * Model queries can report it as P2003. Raw queries through the pg driver
 * adapter report it as P2010 with the SQLSTATE in
 * `meta.driverAdapterError.cause`, so P2003 alone would never match those.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2003') return true;
  const cause = (err.meta as { driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.originalCode === '23503' || cause?.kind === 'ForeignKeyConstraintViolation';
}
