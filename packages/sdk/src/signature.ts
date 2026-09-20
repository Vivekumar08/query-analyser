import { createHash } from 'node:crypto';
import type { FilterShapeItem, OpClass, SortKey } from './types.js';

const MAX_SIGNATURE_LEN = 400;
const MAX_KEYS = 64;

const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte']);
const IN_OPS = new Set(['$in', '$all']);
// $not is treated as negation regardless of what it wraps, because a negated predicate cannot use an index in the E or R position either way.
const NE_OPS = new Set(['$ne', '$nin', '$not']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

export function classifyOp(value: unknown): OpClass {
  if (value instanceof RegExp) return 'regex';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'eq';
  if (value instanceof Date) return 'eq';

  const keys = Object.keys(value as Record<string, unknown>);
  const operators = keys.filter((k) => k.startsWith('$'));
  if (operators.length === 0) return 'eq';

  // Precedence: the most index-relevant classification wins.
  if (operators.some((o) => o === '$eq')) return 'eq';
  if (operators.some((o) => IN_OPS.has(o))) return 'in';
  if (operators.some((o) => RANGE_OPS.has(o))) return 'range';
  if (operators.some((o) => o === '$regex')) return 'regex';
  if (operators.some((o) => o === '$exists')) return 'exists';
  if (operators.some((o) => NE_OPS.has(o))) return 'ne';
  return 'other';
}

export function normalizeKey(path: string): string {
  return path
    .split('.')
    .map((seg) => (/^\d+$/.test(seg) ? '$[]' : seg))
    .join('.');
}

export function flattenFilter(filter: unknown): FilterShapeItem[] {
  const found = new Map<string, OpClass>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
      if (LOGICAL_OPS.has(rawKey)) {
        if (Array.isArray(value)) value.forEach(walk);
        continue;
      }
      if (rawKey.startsWith('$')) {
        // $expr, $text, $where and friends: opaque for index purposes.
        if (!found.has(rawKey)) found.set(rawKey, 'other');
        continue;
      }
      const key = normalizeKey(rawKey);
      if (!found.has(key)) found.set(key, classifyOp(value));
    }
  };

  walk(filter);

  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_KEYS)
    .map(([key, op]) => ({ key, op }));
}

export function normalizeSort(sort: unknown): SortKey[] {
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) return [];
  const out: SortKey[] = [];
  for (const [rawKey, raw] of Object.entries(sort as Record<string, unknown>)) {
    const dir: 1 | -1 = raw === -1 || raw === 'desc' || raw === 'descending' ? -1 : 1;
    out.push({ key: normalizeKey(rawKey), dir });
    if (out.length >= 32) break;
  }
  return out;
}

function stagesOf(pipeline: unknown[] | undefined): string[] {
  if (!Array.isArray(pipeline)) return [];
  return pipeline
    .slice(0, 64)
    .map((stage) => {
      if (!stage || typeof stage !== 'object') return '?';
      return Object.keys(stage as Record<string, unknown>)[0] ?? '?';
    });
}

export interface SignatureInput {
  model: string;
  operation: string;
  filter?: unknown;
  sort?: unknown;
  pipeline?: unknown[];
}

export interface SignatureResult {
  signature: string;
  hash: string;
  model: string;
  operation: string;
  filterShape: FilterShapeItem[];
  sortKeys: SortKey[];
  stages: string[];
}

export function buildSignature(input: SignatureInput): SignatureResult {
  const stages = stagesOf(input.pipeline);
  const isAggregate = stages.length > 0 || input.operation === 'aggregate';

  const filterShape = isAggregate ? [] : flattenFilter(input.filter);
  const sortKeys = isAggregate ? [] : normalizeSort(input.sort);

  const body = isAggregate
    ? stages.join(',')
    : filterShape.map((f) => `${f.key}:${f.op}`).join(',');
  const sortPart = sortKeys.length
    ? `[${sortKeys.map((s) => `${s.key}:${s.dir}`).join(',')}]`
    : '';

  const fullSignature = `${input.model}.${input.operation}(${body})${sortPart}`;
  const hash = createHash('sha256').update(fullSignature).digest('hex').slice(0, 16);
  const signature = fullSignature.slice(0, MAX_SIGNATURE_LEN);

  return {
    signature,
    hash,
    model: input.model,
    operation: isAggregate ? 'aggregate' : input.operation,
    filterShape,
    sortKeys,
    stages,
  };
}
