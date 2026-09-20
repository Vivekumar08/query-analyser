const MAX_DEPTH = 5;
const MAX_KEYS = 32;
// Important 6: an aggregate's `pipeline` and a `$or`/`$in`-shaped filter are
// both arrays of objects. Collapsing every array to a bare type token made
// the dashboard sample for those queries useless (`{"pipeline":
// "<array[object]>"}`). Recursing a bounded number of elements keeps that
// promise (still tokens, still never a value) while making the structure
// spec §4 asks for ("redaction applies to pipeline stages") actually show up.
const MAX_ARRAY_ELEMENTS = 8;

function scalarToken(v: unknown): string | null {
  if (v === null) return '<null>';
  if (v === undefined) return '<undefined>';
  switch (typeof v) {
    case 'string': return '<string>';
    case 'number': return '<number>';
    case 'boolean': return '<boolean>';
    case 'bigint': return '<bigint>';
    case 'function': return '<function>';
    case 'symbol': return '<symbol>';
  }
  // Handle boxed primitives
  if (v instanceof String) return '<string>';
  if (v instanceof Number) return '<number>';
  if (v instanceof Boolean) return '<boolean>';
  // Handle Map and Set
  if (v instanceof Map) return '<Map>';
  if (v instanceof Set) return '<Set>';
  if (v instanceof Date) return '<Date>';
  if (v instanceof RegExp) return '<RegExp>';
  // Duck-typed so we never import mongoose or bson here.
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === 'ObjectId' || ctor === 'ObjectID') return '<ObjectId>';
  if (ctor === 'Decimal128') return '<Decimal128>';
  if (ctor === 'Binary') return '<Binary>';
  if (v instanceof Buffer) return '<Buffer>';
  return null;
}

function arrayToken(arr: unknown[]): string {
  if (arr.length === 0) return '<array[]>';
  const kinds = new Set(arr.slice(0, 16).map((el) => {
    try {
      const t = scalarToken(el);
      if (t) return t.slice(1, -1);
      return Array.isArray(el) ? 'array' : 'object';
    } catch {
      return 'error';
    }
  }));
  return kinds.size === 1 ? `<array[${[...kinds][0]}]>` : '<array[mixed]>';
}

/** true only if every one of the first 16 sampled elements is a scalar. */
function isAllScalar(arr: unknown[]): boolean {
  const sampleSize = Math.min(arr.length, 16);
  for (let i = 0; i < sampleSize; i++) {
    try {
      if (scalarToken(arr[i]) === null) return false;
    } catch {
      // Can't prove it's a scalar — fall back to structural recursion,
      // the safer default, rather than the collapsed token.
      return false;
    }
  }
  return true;
}

// Important 6: arrays of scalars (`['a','b','c']`) keep the old collapse —
// there is no per-key structure to preserve there. Arrays of objects
// (aggregate pipeline stages, `$or`/`$in` filter clauses) recurse into a
// bounded number of elements instead, redacting each one exactly like any
// other object — every existing privacy guarantee (never throws, values
// become tokens, depth is still bounded) applies per element.
function redactArray(arr: unknown[], depth: number, seen: WeakSet<object>): unknown {
  if (arr.length === 0) return '<array[]>';
  if (isAllScalar(arr)) return arrayToken(arr);
  if (depth >= MAX_DEPTH) return '<array>';

  const limit = Math.min(arr.length, MAX_ARRAY_ELEMENTS);
  const out: unknown[] = [];
  for (let i = 0; i < limit; i++) {
    try {
      out.push(redact(arr[i], depth + 1, seen));
    } catch {
      out.push('<error>');
    }
  }
  if (arr.length > limit) out.push('<truncated>');
  return out;
}

/**
 * Replace every leaf value with a token naming its type, keeping only the
 * structure and the keys. No input value can appear in the output.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  let scalar: string | null;
  try {
    scalar = scalarToken(value);
  } catch {
    // If type checking throws (e.g., Proxy trap), treat as object
    scalar = null;
  }
  if (scalar !== null) return scalar;

  if (Array.isArray(value)) return redactArray(value, depth, seen);

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return '<circular>';
  if (depth >= MAX_DEPTH) return '<object>';
  seen.add(obj);

  const out: Record<string, unknown> = {};
  let n = 0;
  let keys: string[] = [];
  try {
    keys = Object.keys(obj);
  } catch {
    // If Object.keys() throws (e.g., Proxy trap), treat as empty object
    seen.delete(obj);
    return out;
  }
  for (const key of keys) {
    if (n++ >= MAX_KEYS) { out['…'] = '<truncated>'; break; }
    try {
      out[key] = redact(obj[key], depth + 1, seen);
    } catch {
      out[key] = '<error>';
    }
  }
  seen.delete(obj);
  return out;
}
