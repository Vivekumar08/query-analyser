import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lex } from './lexer.js';
import { KEYWORDS, RESERVED_KEYWORDS, KNOWN_FUNCTIONS, BUILTIN_TYPES, CAPTURED_VERBS } from './keywords.js';

export const MAX_SQL_CHARS = 16_384;
export const MAX_INPUT_CHARS = 262_144;

export interface SqlFingerprint { sql: string; hash: string; verb: string; table: string | null }

/** 'kw' keyword (upper case), 'word' other unquoted word (lower case), 'ph' a `?` placeholder. */
type NKind = 'kw' | 'word' | 'quoted' | 'ph' | 'op' | 'punct';
interface NToken {
  k: NKind;
  t: string;
  /** word/quoted: the name as written, unquoted (unquoted names lower-cased). */
  name?: string;
  /** Part of a cast type after `::` (masking keeps it only when it is a built-in type name). */
  type?: boolean;
}

const MAIN_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);
const NO_SPACE_BEFORE = new Set([',', ')', ']', '.', '::']);
const NO_SPACE_AFTER = new Set(['(', '[', '.', '::']);

export type MaskKey = Buffer | string;

let processKey: Buffer | undefined;

/**
 * Masks one identifier as `'t_'` + the first 16 hex characters of HMAC-SHA256(key, name).
 * Keyed so that a dictionary of likely names (users, email, ssn…) cannot reverse it.
 *
 * `init()` (Task 8) always supplies the key, derived as `sha256('qa-mask:' + apiKey)`, so
 * masked names are stable across processes of one app. Rotating the API key therefore
 * changes every masked name, and with it every masked fingerprint (history restarts).
 *
 * Without a key, a random per-process key is used: names are consistent within the
 * process but unstable across restarts. That fallback exists only so masking never
 * fails open; it is not what `init()` uses.
 */
export function maskName(name: string, key?: MaskKey): string {
  const k = key ?? (processKey ??= randomBytes(32));
  return 't_' + createHmac('sha256', k).update(name).digest('hex').slice(0, 16);
}

// Postgres folds only ASCII letters in identifiers and keywords (UTF-8), so `ſelect` is not SELECT.
function asciiUpper(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
function asciiLower(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

function unquote(text: string): string {
  const s = text.charCodeAt(0) === 34 ? text : text.slice(2); // strip a U& prefix
  return s.slice(1, -1).replace(/""/g, '"');
}

const isPunct = (tok: NToken | undefined, t: string): boolean => tok !== undefined && tok.k === 'punct' && tok.t === t;
const isSym = (tok: NToken, set: ReadonlySet<string>): boolean => (tok.k === 'punct' || tok.k === 'op') && set.has(tok.t);
const isName = (tok: NToken | undefined): tok is NToken => tok !== undefined && (tok.k === 'word' || tok.k === 'quoted');

/**
 * Pushes a `?`, first dropping any unary `+`/`-` right before it: a sign whose previous
 * token is the statement start, an operator, a keyword, `(`, `[` or `,`. A binary sign
 * (after a name, a literal, `)` or `]`) stays.
 */
function pushLiteral(out: NToken[]): void {
  for (;;) {
    const sign = out[out.length - 1];
    if (sign === undefined || sign.k !== 'op' || (sign.t !== '-' && sign.t !== '+')) break;
    const before = out[out.length - 2];
    const unary = before === undefined || before.k === 'op' || before.k === 'kw' ||
      (before.k === 'punct' && (before.t === '(' || before.t === '[' || before.t === ','));
    if (!unary) break;
    out.pop();
  }
  out.push({ k: 'ph', t: '?' });
}

/**
 * Whether the next name is part of a cast type: right after `::`, after `.` in a dotted
 * type name, or a built-in word continuing a built-in type (`double precision`).
 */
function inTypeChain(out: NToken[], builtin: boolean): boolean {
  const prev = out[out.length - 1];
  if (prev === undefined) return false;
  if (prev.k === 'op' && prev.t === '::') return true;
  if (isPunct(prev, '.')) return out[out.length - 2]?.type === true;
  return builtin && prev.k === 'word' && prev.type === true && BUILTIN_TYPES.has(prev.t);
}

/** Steps 1–3: cap, replace literals, fold case; trailing `;` dropped. */
function toNormalTokens(text: string): NToken[] {
  const cut = text.length > MAX_INPUT_CHARS;
  const raw = lex(cut ? text.slice(0, MAX_INPUT_CHARS) : text);
  const out: NToken[] = [];
  for (const r of raw) {
    switch (r.kind) {
      case 'string': case 'number': case 'param':
        pushLiteral(out);
        break;
      case 'word': {
        const up = asciiUpper(r.text);
        if (up === 'TRUE' || up === 'FALSE') { pushLiteral(out); break; } // booleans are constants, as in pg_stat_statements
        if (KEYWORDS.has(up)) { out.push({ k: 'kw', t: up }); break; }
        const lower = asciiLower(r.text);
        const tok: NToken = { k: 'word', t: lower, name: lower };
        if (inTypeChain(out, BUILTIN_TYPES.has(lower))) tok.type = true;
        out.push(tok);
        break;
      }
      case 'quoted': {
        const tok: NToken = { k: 'quoted', t: r.text, name: unquote(r.text) };
        if (inTypeChain(out, false)) tok.type = true;
        out.push(tok);
        break;
      }
      default:
        out.push({ k: r.kind, t: r.text });
    }
  }
  while (isPunct(out[out.length - 1], ';')) out.pop();
  if (cut) out.push({ k: 'punct', t: '…' });
  return out;
}

/** End index of a list element at `j` (`?`, or `?::type` with a dotted name and `[]`s), or -1. */
function listElementEnd(toks: NToken[], j: number): number {
  if (toks[j]?.k !== 'ph') return -1;
  j++;
  const cast = toks[j];
  if (cast === undefined || cast.k !== 'op' || cast.t !== '::') return j;
  if (!isName(toks[j + 1])) return -1;
  j += 2;
  while (isPunct(toks[j], '.') && isName(toks[j + 1])) j += 2;
  while (isPunct(toks[j], '[') && isPunct(toks[j + 1], ']')) j += 2;
  return j;
}

/** Step 4: `IN (?, …)` → `IN (?)` and `ARRAY[?, …]` → `ARRAY[?]`; elements may be `?::type`. */
function collapseLists(toks: NToken[]): NToken[] {
  const out: NToken[] = [];
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i] as NToken;
    out.push(tok);
    i++;
    const open = tok.k === 'kw' && tok.t === 'IN' ? '(' : tok.k === 'kw' && tok.t === 'ARRAY' ? '[' : null;
    if (open === null || !isPunct(toks[i], open)) continue;
    const close = open === '(' ? ')' : ']';
    const firstEnd = listElementEnd(toks, i + 1);
    if (firstEnd < 0) continue;
    let j = firstEnd;
    while (isPunct(toks[j], ',')) {
      const end = listElementEnd(toks, j + 1);
      if (end < 0) break;
      j = end;
    }
    if (!isPunct(toks[j], close)) continue;
    // Keep the first element (`?` or `?::type`) only.
    for (let k = i; k < firstEnd; k++) out.push(toks[k] as NToken);
    out.push(toks[j] as NToken);
    i = j + 1;
  }
  return out;
}

/** For each `(`, the index of its matching `)`, or -1 (one pass with a stack). */
function matchParens(toks: NToken[]): Int32Array {
  const match = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  for (let j = 0; j < toks.length; j++) {
    const x = toks[j] as NToken;
    if (x.k !== 'punct') continue;
    if (x.t === '(') stack.push(j);
    else if (x.t === ')' && stack.length > 0) match[stack.pop() as number] = j;
  }
  return match;
}

/** Step 5: after `VALUES`, keep only the first of consecutive `( … )` tuples. */
function collapseValues(toks: NToken[]): NToken[] {
  const match = matchParens(toks);
  const out: NToken[] = [];
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i] as NToken;
    out.push(tok);
    i++;
    if (!(tok.k === 'kw' && tok.t === 'VALUES') || !isPunct(toks[i], '(')) continue;
    const firstEnd = match[i] as number;
    if (firstEnd < 0) continue;
    for (let j = i; j <= firstEnd; j++) out.push(toks[j] as NToken);
    i = firstEnd + 1;
    while (isPunct(toks[i], ',') && isPunct(toks[i + 1], '(')) {
      const end = match[i + 1] as number;
      if (end < 0) break;
      i = end + 1;
    }
  }
  return out;
}

/** The lower-case verb and the index of its token, or null when the statement is not captured. */
function findVerb(toks: NToken[]): { verb: string; at: number } | null {
  let s = 0;
  while (isPunct(toks[s], '(')) s++;
  const first = toks[s];
  if (first === undefined || (first.k !== 'kw' && first.k !== 'word')) return null;
  const up = asciiUpper(first.t);
  if (!CAPTURED_VERBS.has(up)) return null;
  if (up !== 'WITH') return { verb: up.toLowerCase(), at: s };
  let depth = 0;
  for (let j = s + 1; j < toks.length; j++) {
    const x = toks[j] as NToken;
    if (x.k === 'punct' && (x.t === '(' || x.t === '[')) depth++;
    else if (x.k === 'punct' && (x.t === ')' || x.t === ']')) { if (--depth < 0) return null; }
    else if (depth === 0 && x.k === 'kw' && MAIN_VERBS.has(x.t)) return { verb: x.t.toLowerCase(), at: j };
  }
  return null;
}

/** Whether the FROM at `j` belongs to `IS [NOT] DISTINCT FROM`. */
function isDistinctFrom(toks: NToken[], j: number): boolean {
  const d = toks[j - 1];
  const b = toks[j - 2];
  return d?.k === 'kw' && d.t === 'DISTINCT' && b?.k === 'kw' && (b.t === 'IS' || b.t === 'NOT');
}

/** The first name after FROM, INTO, or the UPDATE/TABLE verb, at depth 0 of the main statement. */
function findTable(toks: NToken[], at: number): string | null {
  let depth = 0;
  for (let j = at; j < toks.length; j++) {
    const x = toks[j] as NToken;
    if (x.k === 'punct' && (x.t === '(' || x.t === '[')) { depth++; continue; }
    if (x.k === 'punct' && (x.t === ')' || x.t === ']')) { if (--depth < 0) return null; continue; }
    if (depth !== 0 || x.k !== 'kw') continue;
    const trigger = (x.t === 'FROM' && !isDistinctFrom(toks, j)) || x.t === 'INTO' || (j === at && (x.t === 'UPDATE' || x.t === 'TABLE'));
    if (!trigger) continue;
    let k = j + 1;
    const only = toks[k];
    if (only !== undefined && only.k === 'kw' && only.t === 'ONLY') k++;
    let last = toks[k];
    if (!isName(last)) continue;
    while (isPunct(toks[k + 1], '.') && isName(toks[k + 2])) { k += 2; last = toks[k] as NToken; }
    return last.name ?? null;
  }
  return null;
}

/**
 * Whether the word at `k` ends a (dotted) name right after `INTO`, or an alias right after `AS`:
 * a column list follows it, not call arguments, so `(` is not printed tight.
 */
function isTargetName(toks: NToken[], k: number): boolean {
  let start = k;
  while (isPunct(toks[start - 1], '.') && isName(toks[start - 2])) start -= 2;
  const before = toks[start - 1];
  if (before?.k !== 'kw') return false;
  if (before.t === 'INTO') return true;
  // `AS u(x, y)` is an alias column list; `CAST(x AS varchar(10))` is a type.
  return before.t === 'AS' && start === k && !BUILTIN_TYPES.has((toks[k] as NToken).t);
}

/** Step 6: join with single spaces, except around `, ) ] . ::`, `( [`, function calls, `ARRAY[` and cast `[]`. */
function join(toks: NToken[]): string {
  const parts: string[] = [];
  for (let idx = 0; idx < toks.length; idx++) {
    const tok = toks[idx] as NToken;
    const prev = toks[idx - 1];
    if (prev !== undefined) {
      const tight =
        isSym(tok, NO_SPACE_BEFORE) ||
        isSym(prev, NO_SPACE_AFTER) ||
        (prev.k === 'word' && isPunct(tok, '(') && !isTargetName(toks, idx - 1)) ||
        (prev.k === 'kw' && prev.t === 'ARRAY' && isPunct(tok, '[')) ||
        (prev.type === true && isPunct(tok, '['));
      if (!tight) parts.push(' ');
    }
    parts.push(tok.t);
  }
  return parts.join('');
}

/**
 * Where a non-reserved keyword that is also a plausible column name is used as a keyword.
 * Elsewhere masking treats it as an identifier (`SELECT first, rows FROM t`).
 */
const KEYWORD_CONTEXT: ReadonlyMap<string, (prev: NToken | undefined, next: NToken | undefined) => boolean> = new Map([
  ['FIRST', (p: NToken | undefined) => p?.k === 'kw' && (p.t === 'NULLS' || p.t === 'FETCH')],
  ['LAST', (p: NToken | undefined) => p?.k === 'kw' && p.t === 'NULLS'],
  ['NULLS', (_p: NToken | undefined, n: NToken | undefined) => n?.k === 'kw' && (n.t === 'FIRST' || n.t === 'LAST')],
  ['ROWS', (p: NToken | undefined, n: NToken | undefined) =>
    p?.k === 'ph' || n?.k === 'ph' || (n?.k === 'kw' && n.t === 'BETWEEN') || (n?.k === 'word' && (n.t === 'unbounded' || n.t === 'current'))],
]);

/**
 * Masking keeps only reserved (Appendix C) keywords, other keywords in keyword use, known
 * functions when called, and built-in type names in a cast. Every other name is masked.
 */
function mask(toks: NToken[], key: MaskKey | undefined): NToken[] {
  const out: NToken[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i] as NToken;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (tok.k === 'quoted') {
      out.push({ ...tok, t: maskName(tok.name ?? '', key) });
    } else if (tok.k === 'word') {
      const keep = (tok.type === true && BUILTIN_TYPES.has(tok.t)) || (KNOWN_FUNCTIONS.has(tok.t) && isPunct(next, '('));
      out.push(keep ? tok : { ...tok, t: maskName(tok.name ?? tok.t, key) });
    } else if (tok.k === 'kw' && !RESERVED_KEYWORDS.has(tok.t)) {
      const ctx = KEYWORD_CONTEXT.get(tok.t);
      const asName = isPunct(prev, '.') || isPunct(next, '.') || (ctx !== undefined && !ctx(prev, next));
      out.push(asName ? { k: 'word', t: maskName(asciiLower(tok.t), key) } : tok);
    } else {
      out.push(tok);
    }
  }
  return out;
}

/** The fingerprint of one statement, or null when it is not a captured statement. Pure; never throws. */
export function fingerprintSql(text: string, opts: { maskIdentifiers: boolean; maskKey?: MaskKey }): SqlFingerprint | null {
  try {
    if (typeof text !== 'string') return null;
    let toks = collapseValues(collapseLists(toNormalTokens(text)));
    const found = findVerb(toks);
    if (found === null) return null;
    let table = findTable(toks, found.at);
    if (opts.maskIdentifiers) {
      toks = mask(toks, opts.maskKey);
      if (table !== null) table = maskName(table, opts.maskKey);
    }
    const full = join(toks);
    const hash = createHash('sha256').update('postgresql\n' + full).digest('hex').slice(0, 16);
    let sql = full;
    if (full.length > MAX_SQL_CHARS) {
      let cutAt = MAX_SQL_CHARS - 1;
      const c = full.charCodeAt(cutAt - 1);
      if (c >= 0xd800 && c <= 0xdbff) cutAt--; // never split a surrogate pair
      sql = full.slice(0, cutAt) + '…';
    }
    return { sql, hash, verb: found.verb, table };
  } catch {
    return null;
  }
}

/**
 * A fingerprinter with an LRU cache keyed by the raw text. Texts over MAX_SQL_CHARS are not cached.
 * `maskKey` keys identifier masking (see `maskName`); `init()` passes `sha256('qa-mask:' + apiKey)`.
 */
export function createFingerprinter(
  opts: { maskIdentifiers: boolean; maskKey?: MaskKey; maxEntries?: number },
): (text: string) => SqlFingerprint | null {
  const maskIdentifiers = opts.maskIdentifiers;
  const maskKey = opts.maskKey;
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? 2_000));
  const cache = new Map<string, SqlFingerprint | null>();
  return (text: string) => {
    const cacheable = typeof text === 'string' && text.length <= MAX_SQL_CHARS;
    if (cacheable && cache.has(text)) {
      const hit = cache.get(text) as SqlFingerprint | null;
      cache.delete(text);
      cache.set(text, hit);
      return hit;
    }
    const result = fingerprintSql(text, { maskIdentifiers, maskKey });
    if (cacheable) {
      cache.set(text, result);
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
    }
    return result;
  };
}
