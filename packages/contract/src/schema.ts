import { z } from 'zod';
import { HIST_SIZE } from './runtime.js';

export const opClassSchema = z.enum(['eq', 'in', 'range', 'regex', 'exists', 'ne', 'other']);

export const filterShapeItemSchema = z.object({
  key: z.string().min(1).max(200),
  op: opClassSchema,
});

export const sortKeySchema = z.object({
  key: z.string().min(1).max(200),
  dir: z.union([z.literal(1), z.literal(-1)]),
});

export const ingestItemSchema = z.object({
  signature: z.string().min(1).max(400),
  hash: z.string().length(16),
  model: z.string().min(1).max(200),
  operation: z.string().min(1).max(40),
  filterShape: z.array(filterShapeItemSchema).max(64),
  sortKeys: z.array(sortKeySchema).max(32),
  stages: z.array(z.string().max(40)).max(64),
  count: z.number().int().nonnegative(),
  totalMs: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
  lastMs: z.number().nonnegative(),
  lastTs: z.number().int().nonnegative(),
  hist: z.array(z.number().int().nonnegative()).length(HIST_SIZE),
  sample: z.unknown().nullable(),
});

export const ingestPayloadSchema = z.object({
  app: z.string().min(1).max(100),
  env: z.string().min(1).max(40),
  host: z.string().max(200),
  sdkVersion: z.string().max(40),
  bucket: z.string().regex(/^\d{10}$/),
  thresholdMs: z.number().int().positive(),
  dropped: z.number().int().nonnegative(),
  items: z.array(ingestItemSchema).max(5000),
});

export type IngestPayloadParsed = z.infer<typeof ingestPayloadSchema>;
