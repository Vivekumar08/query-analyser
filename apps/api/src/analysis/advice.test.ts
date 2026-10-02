import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '../generated/prisma/client.js';
import { adviceFor } from './advice.js';
import { resetDb } from '../test/db.js';

const { buildApp } = await import('../app.js');

describe('adviceFor', () => {
  it('orders equality, then sort, then range', () => {
    const r = adviceFor(
      [
        { key: 'status', op: 'eq' },
        { key: 'createdAt', op: 'range' },
      ],
      [{ key: 'placedAt', dir: -1 }],
    );
    expect(r!.suggestion.map((s) => s.field)).toEqual(['status', 'placedAt', 'createdAt']);
    expect(r!.suggestion).toEqual([
      { field: 'status', dir: 1 },
      { field: 'placedAt', dir: -1 },
      { field: 'createdAt', dir: 1 },
    ]);
  });

  it('treats $in as equality', () => {
    const r = adviceFor([{ key: 'tenant', op: 'in' }], []);
    expect(r!.suggestion.map((s) => s.field)).toEqual(['tenant']);
  });

  it('excludes regex, ne and other, and names them in the rationale', () => {
    const r = adviceFor(
      [
        { key: 'status', op: 'eq' },
        { key: 'name', op: 'regex' },
        { key: 'kind', op: 'ne' },
        { key: 'misc', op: 'other' },
      ],
      [],
    );
    expect(r!.suggestion.map((s) => s.field)).toEqual(['status']);
    expect(r!.rationale).toContain('name');
    expect(r!.rationale).toContain('kind');
    expect(r!.rationale).toContain('misc');
  });

  it('places exists after the sort keys, with the range fields', () => {
    const r = adviceFor(
      [
        { key: 'deletedAt', op: 'exists' },
        { key: 'status', op: 'eq' },
      ],
      [{ key: 'placedAt', dir: 1 }],
    );
    expect(r!.suggestion.map((s) => s.field)).toEqual(['status', 'placedAt', 'deletedAt']);
  });

  it('gives no advice for an empty shape', () => {
    expect(adviceFor([], [])).toBeNull();
  });

  it('gives no advice when the filter is only _id', () => {
    // _id is always indexed. Suggesting it is noise.
    expect(adviceFor([{ key: '_id', op: 'eq' }], [])).toBeNull();
  });

  it('gives no advice when every field is unindexable', () => {
    expect(adviceFor([{ key: 'name', op: 'regex' }], [])).toBeNull();
  });

  it('says plainly that this is a shape heuristic, not a verified plan', () => {
    const r = adviceFor([{ key: 'status', op: 'eq' }], []);
    expect(r!.rationale).toMatch(/heuristic|never seen/i);
  });

  it('excludes _id from equality fields when mixed with meaningful fields', () => {
    const r = adviceFor([{ key: '_id', op: 'eq' }, { key: 'status', op: 'eq' }], []);
    expect(r!.suggestion.map((s) => s.field)).toEqual(['status']);
  });

  it('excludes _id from range fields when mixed with meaningful fields', () => {
    const r = adviceFor([{ key: '_id', op: 'range' }, { key: 'status', op: 'eq' }], []);
    expect(r!.suggestion.map((s) => s.field)).toEqual(['status']);
  });
});

/**
 * jsonb does not preserve object key order (it canonicalises by key length,
 * then bytewise) — `{ at: -1, tenantId: 1 }` round-trips as itself, but
 * `{ tenantId: 1, at: -1 }` would NOT, because 'at' (2 chars) sorts before
 * 'tenantId' (8 chars) regardless of insertion order. This is exactly why
 * `suggestion` is stored as an *array* of `{ field, dir }` pairs rather than
 * an object keyed by field name: jsonb preserves array element order even
 * though it does not preserve object key order. These tests write through a
 * real Postgres connection (not a mock) so a regression to the object shape
 * would be caught by an actual canonicalisation, not by an assumption about
 * one.
 */
describe('Advice.suggestion round-trips field order through jsonb', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    await resetDb(app.prisma);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('keeps ESR order (tenantId before at) after a write/read round trip', async () => {
    const org = await app.prisma.organization.create({
      data: { name: 'Round Trip Co', slug: `rt-${Date.now()}-${Math.random()}` },
    });
    const a = await app.prisma.app.create({
      data: { orgId: org.id, name: 'rt', env: 'production' },
    });
    const sig = await app.prisma.querySignature.create({
      data: {
        appId: a.id,
        hash: `rt${Date.now()}`.slice(0, 16).padEnd(16, '0'),
        signature: 'rt.find({tenantId,at})',
        model: 'rt',
        operation: 'find',
        filterShape: [{ key: 'tenantId', op: 'eq' }],
        sortKeys: [{ key: 'at', dir: -1 }],
        stages: [],
      },
    });

    // `adviceFor` builds equality fields before sort keys: tenantId (eq)
    // then at (sort) — the ESR order, and the opposite of jsonb's own
    // canonical ordering for these two field names (`at` is shorter than
    // `tenantId`, so an object-keyed jsonb column would reorder it first).
    const computed = adviceFor(
      [{ key: 'tenantId', op: 'eq' }],
      [{ key: 'at', dir: -1 }],
    );
    expect(computed).not.toBeNull();
    expect(computed!.suggestion.map((s) => s.field)).toEqual(['tenantId', 'at']);

    await app.prisma.advice.create({
      data: {
        signatureId: sig.id,
        suggestion: computed!.suggestion as unknown as Prisma.InputJsonArray,
        rationale: computed!.rationale,
      },
    });

    const stored = await app.prisma.advice.findUniqueOrThrow({
      where: { signatureId: sig.id },
    });

    const storedSuggestion = stored.suggestion as unknown as { field: string; dir: number }[];
    expect(storedSuggestion.map((s) => s.field)).toEqual(['tenantId', 'at']);
    expect(storedSuggestion).toEqual([
      { field: 'tenantId', dir: 1 },
      { field: 'at', dir: -1 },
    ]);
  });
});
