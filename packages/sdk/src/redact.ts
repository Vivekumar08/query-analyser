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
    const t = scalarToken(el);
    if (t) return t.slice(1, -1);
    return Array.isArray(el) ? 'array' : 'object';
  }));
  return kinds.size === 1 ? `<array[${[...kinds][0]}]>` : '<array[mixed]>';
}

/**
 * Replace every leaf value with a token naming its type, keeping only the
 * structure and the keys. No input value can appear in the output.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  const scalar = scalarToken(value);
  if (scalar !== null) return scalar;

  if (Array.isArray(value)) return arrayToken(value);

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return '<circular>';
  if (depth >= MAX_DEPTH) return '<object>';
  seen.add(obj);

  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key of Object.keys(obj)) {
    if (n++ >= MAX_KEYS) { out['…'] = '<truncated>'; break; }
    out[key] = redact(obj[key], depth + 1, seen);
  }
  seen.delete(obj);
  return out;
}
