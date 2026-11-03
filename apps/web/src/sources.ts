/** Labels for a query's data source, ORM and sampling. Rows from an API that predates SQL carry none of these: they are MongoDB. */
export const SOURCE_LABEL: Record<string, string> = { postgresql: 'PostgreSQL', mongodb: 'MongoDB' };

const ORM_LABEL: Record<string, string> = { prisma: 'Prisma' };

export function sourceLabel(source: string | undefined): string {
  const s = source ?? 'mongodb';
  return SOURCE_LABEL[s] ?? s;
}

export function ormLabel(source: string | undefined, orm: string | null | undefined): string {
  if (orm) return ORM_LABEL[orm] ?? orm;
  return (source ?? 'mongodb') === 'mongodb' ? 'Mongoose / driver' : 'pg';
}

/** "estimated (sampled at 10%)" for a sampled window; null when nothing was sampled. */
export function sampledLabel(rate: number | null | undefined): string | null {
  if (rate === null || rate === undefined || rate >= 1) return null;
  return `estimated (sampled at ${Number((rate * 100).toFixed(2))}%)`;
}
