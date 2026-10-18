/**
 * Builds a ready-to-paste mongosh / Compass command for a query.
 *
 * Two inputs, one renderer:
 * - placeholder mode reads the SDK's redacted sample, where every leaf is a
 *   type token such as "<string>" (packages/sdk/src/redact.ts). Tokens are
 *   written unquoted, a string token taking its hint from the enclosing field
 *   name (`{ email: <email> }`).
 * - real mode reads the decrypted Extended-JSON-like text the SDK serialised
 *   (packages/sdk/src/ejson.ts) and writes mongosh literals: ObjectId(…),
 *   ISODate(…), /re/flags, NumberDecimal(…), NumberLong(…), BinData(…), …
 *
 * Every string and key is escaped with JSON.stringify, so a value can never
 * break out of its literal. Pure: the output only ever reaches the screen
 * and the clipboard.
 */

export interface SampleParts {
  filter?: unknown;
  sort?: unknown;
  update?: unknown;
  pipeline?: unknown;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** A redactor type token: `<string>`, `<array[string]>`, `<truncated>`, … */
const TOKEN = /^<[^<>]+>$/;
/** Field names safe to show inside a placeholder's angle brackets. */
const HINT = /^[\w.-]{1,64}$/;

/** mongoose's usual collection name: lowercased and pluralised. */
export function defaultCollection(model: string): string {
  const m = model.toLowerCase();
  if (/[^aeiou]y$/.test(m)) return `${m.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(m)) return `${m}es`;
  return `${m}s`;
}

const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

function renderObject(entries: [string, string][]): string {
  return entries.length === 0 ? '{}' : `{ ${entries.map(([k, v]) => `${key(k)}: ${v}`).join(', ')} }`;
}

// ---------------------------------------------------------------- placeholders

function placeholder(token: string, field: string | undefined): string {
  if (token === '<string>' && field !== undefined && HINT.test(field)) return `<${field}>`;
  return token;
}

function renderPlaceholder(v: unknown, field: string | undefined): string {
  if (typeof v === 'string') return TOKEN.test(v) ? placeholder(v, field) : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((el) => renderPlaceholder(el, field)).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    // Operators (`$in`, `$eq`) keep the enclosing field as the hint.
    return renderObject(Object.entries(v).map(([k, el]) => [k, renderPlaceholder(el, k.startsWith('$') ? field : k)]));
  }
  return JSON.stringify(v) ?? 'null';
}

/** The redacted sample as mongosh text with readable, unquoted placeholders. */
export function placeholderize(redacted: unknown): string {
  return renderPlaceholder(redacted, undefined);
}

// ----------------------------------------------------------------- real values

function only(o: Record<string, unknown>, ...keys: string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

function regexLiteral(pattern: string, options: string): string {
  try {
    // `source` re-escapes `/` and line terminators, so the literal is always valid.
    if (/^[a-z]*$/.test(options)) return `/${new RegExp(pattern, options).source}/${options}`;
  } catch {
    // PCRE-only syntax or flags (e.g. `x`): the server-side operator still works.
  }
  return `{ $regex: ${JSON.stringify(pattern)}, $options: ${JSON.stringify(options)} }`;
}

/** An Extended-JSON wrapper as a mongosh literal, or null if `o` is a plain document. */
function ejsonLiteral(o: Record<string, unknown>): string | null {
  const s = (v: unknown) => typeof v === 'string';
  if (only(o, '$oid') && s(o.$oid)) return `ObjectId(${JSON.stringify(o.$oid)})`;
  if (only(o, '$date') && (s(o.$date) || o.$date === null)) {
    return o.$date === null ? 'new Date(NaN)' : `ISODate(${JSON.stringify(o.$date)})`;
  }
  if (only(o, '$regex', '$options') && s(o.$regex) && s(o.$options)) return regexLiteral(o.$regex as string, o.$options as string);
  if (only(o, '$numberDecimal') && s(o.$numberDecimal)) return `NumberDecimal(${JSON.stringify(o.$numberDecimal)})`;
  if (only(o, '$numberLong') && s(o.$numberLong)) return `NumberLong(${JSON.stringify(o.$numberLong)})`;
  if (only(o, '$numberDouble') && ['NaN', 'Infinity', '-Infinity'].includes(o.$numberDouble as string)) return o.$numberDouble as string;
  if (only(o, '$binary') && o.$binary && typeof o.$binary === 'object') {
    const b = o.$binary as Record<string, unknown>;
    if (only(b, 'base64', 'subType') && s(b.base64) && s(b.subType) && /^[0-9a-f]{1,2}$/i.test(b.subType as string)) {
      return `BinData(${parseInt(b.subType as string, 16)}, ${JSON.stringify(b.base64)})`;
    }
  }
  if (only(o, '$timestamp') && o.$timestamp && typeof o.$timestamp === 'object') {
    const t = o.$timestamp as Record<string, unknown>;
    if (only(t, 't', 'i') && Number.isSafeInteger(t.t) && Number.isSafeInteger(t.i)) return `Timestamp({ t: ${t.t}, i: ${t.i} })`;
  }
  if (only(o, '$minKey') && o.$minKey === 1) return 'MinKey()';
  if (only(o, '$maxKey') && o.$maxKey === 1) return 'MaxKey()';
  return null;
}

function renderReal(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(renderReal).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return ejsonLiteral(o) ?? renderObject(Object.entries(o).map(([k, el]) => [k, renderReal(el)]));
  }
  // Strings (including the SDK's "<circular>"-style markers) stay quoted strings.
  return JSON.stringify(v) ?? 'null';
}

/** mongoose's string sort (`"-createdAt name"`) as a sort document. */
function sortDocument(sort: string): Record<string, 1 | -1> {
  const out: Record<string, 1 | -1> = {};
  for (const part of sort.trim().split(/\s+/).filter(Boolean)) {
    if (part.startsWith('-')) out[part.slice(1)] = -1;
    else out[part.replace(/^\+/, '')] = 1;
  }
  return out;
}

/** Parses decrypted sample text; null unless it is a sample object. */
export function parseRealSample(text: string): SampleParts | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as SampleParts) : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- command

/** Older SDKs stored an absent sort/update as the token "<undefined>". */
const present = (v: unknown) => v !== undefined && v !== null && v !== '<undefined>';

export function compassCommand(collection: string, sample: SampleParts, opts: { placeholder: boolean }): string {
  const render = opts.placeholder ? placeholderize : renderReal;
  const coll = `db.getCollection(${JSON.stringify(collection)})`;
  const explain = '.explain("executionStats")';
  if (present(sample.pipeline)) return `${coll}.aggregate(${render(sample.pipeline)})${explain}`;

  const filter = present(sample.filter) ? render(sample.filter) : '{}';
  let sort = '';
  if (present(sample.sort)) {
    const s = !opts.placeholder && typeof sample.sort === 'string' ? sortDocument(sample.sort) : sample.sort;
    sort = `.sort(${render(s)})`;
  }
  return `${coll}.find(${filter})${sort}${explain}`;
}
