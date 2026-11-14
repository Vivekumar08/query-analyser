import { describe, it, expect } from 'vitest';
import { ormLabel, sampledLabel, sourceLabel } from './sources';

describe('sources', () => {
  it('sourceLabel', () => {
    expect(sourceLabel(undefined)).toBe('MongoDB');
    expect(sourceLabel('postgresql')).toBe('PostgreSQL');
    expect(sourceLabel('mysql')).toBe('mysql');
  });
  it('ormLabel', () => {
    expect(ormLabel('postgresql', 'prisma')).toBe('Prisma');
    expect(ormLabel(undefined, null)).toBe('Mongoose / driver');
    expect(ormLabel('mongodb', null)).toBe('Mongoose / driver');
    expect(ormLabel('postgresql', null)).toBe('pg');
    expect(ormLabel('postgresql', 'knex')).toBe('knex');
  });
  it('sampledLabel', () => {
    expect(sampledLabel(0.1)).toBe('estimated (sampled at 10%)');
    expect(sampledLabel(0.125)).toBe('estimated (sampled at 12.5%)');
    expect(sampledLabel(1)).toBeNull();
    expect(sampledLabel(null)).toBeNull();
    expect(sampledLabel(undefined)).toBeNull();
  });
});
