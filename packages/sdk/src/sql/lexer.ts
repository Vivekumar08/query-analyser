export type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'param' | 'op' | 'punct';
/** Comments and whitespace are not tokens. */
export interface Token { kind: TokenKind; text: string }

const OP_CHARS = new Set('+-*/<>=~!@#%^&|`?');
// A multi-character operator may end in + or - only when it contains one of these.
const OP_KEEP_TRAILING = new Set('~!@#%^&|`?');
const PUNCT = new Set('()[],;.');

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
}
function isIdentCont(c: number): boolean {
  return isIdentStart(c) || isDigit(c) || c === 36;
}
function isHex(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/** End index (exclusive) of a quoted run that opens at `start`, or -1 when unterminated. */
function scanQuoted(text: string, start: number, quote: number, backslash: boolean): number {
  const n = text.length;
  let j = start + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (backslash && c === 92) { j += 2; continue; }
    if (c === quote) {
      if (text.charCodeAt(j + 1) === quote) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return -1;
}

/** End index (exclusive) of a nested block comment opening at `start`, or the text length when unterminated. */
function scanBlockComment(text: string, start: number): number {
  const n = text.length;
  let depth = 1;
  let j = start + 2;
  while (j < n) {
    const c = text.charCodeAt(j);
    const d = text.charCodeAt(j + 1);
    if (c === 47 && d === 42) { depth++; j += 2; continue; }
    if (c === 42 && d === 47) {
      depth--; j += 2;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  return n;
}

function scanNumber(text: string, start: number): number {
  const n = text.length;
  let j = start;
  if (text.charCodeAt(j) === 48) {
    const p = text.charCodeAt(j + 1) | 32; // lower-case letter
    const ok = p === 120 ? isHex : p === 111 ? (c: number) => c >= 48 && c <= 55 : p === 98 ? (c: number) => c === 48 || c === 49 : null;
    if (ok) {
      let k = j + 2;
      while (k < n && (ok(text.charCodeAt(k)) || text.charCodeAt(k) === 95)) k++;
      if (k > j + 2) return k;
    }
  }
  while (j < n && (isDigit(text.charCodeAt(j)) || text.charCodeAt(j) === 95)) j++;
  if (text.charCodeAt(j) === 46 && text.charCodeAt(j + 1) !== 46) {
    j++;
    while (j < n && (isDigit(text.charCodeAt(j)) || text.charCodeAt(j) === 95)) j++;
  }
  if ((text.charCodeAt(j) | 32) === 101) {
    const s = text.charCodeAt(j + 1);
    const k = s === 43 || s === 45 ? j + 2 : j + 1;
    if (isDigit(text.charCodeAt(k))) {
      j = k;
      while (j < n && (isDigit(text.charCodeAt(j)) || text.charCodeAt(j) === 95)) j++;
    }
  }
  return j;
}

/** End index (exclusive) of a `$tag$` / `$$` opener at `start`, or -1 when the `$` does not open a dollar quote. */
function scanDollarTag(text: string, start: number): number {
  const n = text.length;
  let j = start + 1;
  if (text.charCodeAt(j) === 36) return j + 1;
  if (j >= n || !isIdentStart(text.charCodeAt(j))) return -1;
  j++;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 36) return j + 1;
    if (!isIdentStart(c) && !isDigit(c)) return -1;
    j++;
  }
  return -1;
}

/**
 * A PostgreSQL lexer: one pass with a cursor, pure, never throws. Comments and
 * whitespace are dropped. An unterminated string, quoted identifier or dollar
 * quote turns the rest of the text into one `string` token; an unterminated
 * block comment drops the rest.
 */
export function lex(text: string): Token[] {
  const out: Token[] = [];
  const n = text.length;
  let i = 0;

  const quoted = (start: number, open: number, quote: number, backslash: boolean, kind: TokenKind): boolean => {
    const end = scanQuoted(text, open, quote, backslash);
    if (end < 0) { out.push({ kind: 'string', text: text.slice(start) }); return false; }
    out.push({ kind, text: text.slice(start, end) });
    i = end;
    return true;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    const d = text.charCodeAt(i + 1);

    if (isSpace(c)) { i++; continue; }
    if (c === 45 && d === 45) { // -- comment
      const nl = text.indexOf('\n', i + 2);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === 47 && d === 42) { i = scanBlockComment(text, i); continue; } // /* comment */

    if (c === 39) { if (!quoted(i, i, 39, false, 'string')) break; continue; }
    if (c === 34) { if (!quoted(i, i, 34, false, 'quoted')) break; continue; }

    if (isIdentStart(c)) {
      const lc = c | 32;
      if (d === 39 && (lc === 101 || lc === 98 || lc === 120 || lc === 110)) { // E'' B'' X'' N''
        if (!quoted(i, i + 1, 39, lc === 101, 'string')) break;
        continue;
      }
      if (lc === 117 && d === 38) { // U&'' and U&""
        const q = text.charCodeAt(i + 2);
        if (q === 39) { if (!quoted(i, i + 2, 39, false, 'string')) break; continue; }
        if (q === 34) { if (!quoted(i, i + 2, 34, false, 'quoted')) break; continue; }
      }
      let j = i + 1;
      while (j < n && isIdentCont(text.charCodeAt(j))) j++;
      out.push({ kind: 'word', text: text.slice(i, j) });
      i = j;
      continue;
    }

    if (isDigit(c) || (c === 46 && isDigit(d))) {
      const j = scanNumber(text, i);
      out.push({ kind: 'number', text: text.slice(i, j) });
      i = j;
      continue;
    }

    if (c === 36) { // $
      if (isDigit(d)) {
        let j = i + 1;
        while (j < n && isDigit(text.charCodeAt(j))) j++;
        out.push({ kind: 'param', text: text.slice(i, j) });
        i = j;
        continue;
      }
      const tagEnd = scanDollarTag(text, i);
      if (tagEnd > 0) {
        const close = text.indexOf(text.slice(i, tagEnd), tagEnd);
        if (close < 0) { out.push({ kind: 'string', text: text.slice(i) }); break; }
        const end = close + (tagEnd - i);
        out.push({ kind: 'string', text: text.slice(i, end) });
        i = end;
        continue;
      }
      out.push({ kind: 'op', text: '$' });
      i++;
      continue;
    }

    if (c === 58) { // : and ::
      const two = d === 58;
      out.push({ kind: 'op', text: two ? '::' : ':' });
      i += two ? 2 : 1;
      continue;
    }

    const ch = text[i] as string;
    if (PUNCT.has(ch)) { out.push({ kind: 'punct', text: ch }); i++; continue; }

    if (OP_CHARS.has(ch)) {
      let j = i + 1;
      while (j < n) {
        const e = text[j] as string;
        if (!OP_CHARS.has(e)) break;
        const f = text.charCodeAt(j + 1);
        if ((e === '-' && f === 45) || (e === '/' && f === 42)) break;
        j++;
      }
      let run = text.slice(i, j);
      if (run.length > 1) {
        let keep = false;
        for (const x of run) if (OP_KEEP_TRAILING.has(x)) { keep = true; break; }
        if (!keep) while (run.length > 1 && (run.endsWith('+') || run.endsWith('-'))) run = run.slice(0, -1);
      }
      out.push({ kind: 'op', text: run });
      i += run.length;
      continue;
    }

    // Anything else (\, {, }, other stray ASCII) is a one-character operator.
    out.push({ kind: 'op', text: ch });
    i++;
  }
  return out;
}
