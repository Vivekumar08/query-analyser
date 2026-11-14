import { describe, it, expect } from 'vitest';
import { lex } from './lexer.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('lex', () => {
  it.each([
    [`'it''s'`, 'string'], [`E'it\\'s'`, 'string'], [`B'101'`, 'string'], [`X'ff'`, 'string'], [`U&'d\\0061t'`, 'string'],
    ['$tag$a $$ b$tag$', 'string'], ['$$x$$', 'string'], ['"My ""T"""', 'quoted'], ['1_000.5e-3', 'number'], ['0x1F', 'number'], ['$12', 'param'],
  ])('lexes %s as one %s token', (text, kind) => expect(lex(text)).toEqual([{ kind, text }]));

  it('drops -- and nested /* */ comments', () =>
    expect(lex('/* a /* b */ c */ SELECT 1 -- x').map((t) => t.text)).toEqual(['SELECT', '1']));

  it('an unterminated string swallows the rest as one string token', () =>
    expect(lex(`SELECT 'abc FROM t`)).toEqual([{ kind: 'word', text: 'SELECT' }, { kind: 'string', text: `'abc FROM t` }]));

  it('an unterminated dollar quote and an unterminated comment do not throw', () => {
    expect(() => lex('SELECT $q$abc')).not.toThrow();
    expect(lex('SELECT $q$abc')).toEqual([{ kind: 'word', text: 'SELECT' }, { kind: 'string', text: '$q$abc' }]);
    expect(lex('SELECT 1 /* open').map((t) => t.text)).toEqual(['SELECT', '1']);
  });

  it('an unterminated quoted identifier becomes one string token', () =>
    expect(lex('SELECT "abc')).toEqual([{ kind: 'word', text: 'SELECT' }, { kind: 'string', text: '"abc' }]));

  it('lexes casts, operators, punctuation, words and U& identifiers', () => {
    expect(lex('a.b::int[] <= $1, (x);')).toEqual([
      { kind: 'word', text: 'a' }, { kind: 'punct', text: '.' }, { kind: 'word', text: 'b' }, { kind: 'op', text: '::' },
      { kind: 'word', text: 'int' }, { kind: 'punct', text: '[' }, { kind: 'punct', text: ']' }, { kind: 'op', text: '<=' },
      { kind: 'param', text: '$1' }, { kind: 'punct', text: ',' }, { kind: 'punct', text: '(' }, { kind: 'word', text: 'x' },
      { kind: 'punct', text: ')' }, { kind: 'punct', text: ';' },
    ]);
    expect(lex('U&"d\\0061t"')).toEqual([{ kind: 'quoted', text: 'U&"d\\0061t"' }]);
    expect(lex('_count$_all')).toEqual([{ kind: 'word', text: '_count$_all' }]);
  });

  it('lexes numbers in every form', () => {
    for (const n of ['0', '42', '3.14', '.5', '5.', '1e10', '2E+3', '0o17', '0b1010', '0x_ff', '1_000_000'])
      expect(lex(n)).toEqual([{ kind: 'number', text: n }]);
  });

  it('does not let an operator run swallow a comment or end in a bare minus', () => {
    expect(lex('a =-- c\n1').map((t) => t.text)).toEqual(['a', '=', '1']);
    expect(lex('a+/* c */b').map((t) => t.text)).toEqual(['a', '+', 'b']);
    expect(lex('a=-1').map((t) => t.text)).toEqual(['a', '=', '-', '1']);
    expect(lex('a @- b').map((t) => t.text)).toEqual(['a', '@-', 'b']);
    expect(lex('a <+- b').map((t) => t.text)).toEqual(['a', '<', '+', '-', 'b']);
    expect(lex('+++').map((t) => t.text)).toEqual(['+', '+', '+']);
  });

  it('an E string keeps backslash-escaped quotes inside', () =>
    expect(lex(`e'a\\'b' x`)).toEqual([{ kind: 'string', text: `e'a\\'b'` }, { kind: 'word', text: 'x' }]));

  it('never throws on 10,000 random strings', () => {
    const rand = mulberry32(20261101);
    const alphabet = `'"$-/*()[]:;,.eEuUbBxX&0123456789abc_ \n\\`;
    for (let i = 0; i < 10_000; i++) {
      const len = Math.floor(rand() * 40);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
      let tokens: ReturnType<typeof lex> = [];
      expect(() => { tokens = lex(s); }).not.toThrow();
      for (const t of tokens) expect(t.text.length).toBeGreaterThan(0);
    }
  });

  it('stays linear on adversarial input', () => {
    const inputs = ['/*'.repeat(100_000), '$a'.repeat(100_000), "E'\\".repeat(100_000), '-'.repeat(200_000), '$$'.repeat(100_000), '+'.repeat(200_000), '<' + '+-'.repeat(100_000)];
    const start = performance.now();
    for (const s of inputs) lex(s);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
