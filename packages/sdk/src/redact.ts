const MAX_DEPTH = 5;
const MAX_KEYS = 32;

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

  if (Array.isArray(value)) return arrayToken(value);

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
