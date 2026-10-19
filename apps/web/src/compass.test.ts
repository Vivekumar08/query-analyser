import { describe, it, expect } from 'vitest';
import { compassCommand, defaultCollection, parseRealSample, placeholderize } from './compass';

describe('defaultCollection', () => {
  it.each([
    ['Order', 'orders'],
    ['Category', 'categories'],
    ['Box', 'boxes'],
    ['Address', 'addresses'],
    ['Church', 'churches'],
    ['Wish', 'wishes'],
    ['Day', 'days'],
    ['User', 'users'],
  ])('%s -> %s', (model, expected) => {
    expect(defaultCollection(model)).toBe(expected);
  });
});

describe('placeholderize', () => {
  it('turns a string token into a hint from its field name, unquoted', () => {
    expect(placeholderize({ email: '<string>' })).toBe('{ email: <email> }');
  });

  it('takes the hint from the enclosing field through operators', () => {
    expect(placeholderize({ email: { $in: '<array[string]>' }, name: { $eq: '<string>' } }))
      .toBe('{ email: { $in: <array[string]> }, name: { $eq: <name> } }');
  });

  it('falls back to the type name with no field to hint from', () => {
    expect(placeholderize({ age: '<number>', at: '<Date>' })).toBe('{ age: <number>, at: <Date> }');
    expect(placeholderize('<string>')).toBe('<string>');
    expect(placeholderize({ $or: [{ $text: '<string>' }] })).toBe('{ $or: [{ $text: <string> }] }');
  });

  it('quotes keys that are not identifiers and never emits a raw quote', () => {
    expect(placeholderize({ 'user.email': '<string>', 'a"b': '<number>' }))
      .toBe('{ "user.email": <user.email>, "a\\"b": <number> }');
    // A key that is not a safe hint falls back to the type.
    expect(placeholderize({ 'a b>': '<string>' })).toBe('{ "a b>": <string> }');
  });

  it('keeps an empty object and array', () => {
    expect(placeholderize({})).toBe('{}');
    expect(placeholderize([])).toBe('[]');
  });
});

describe('compassCommand (placeholders)', () => {
  it('find + sort', () => {
    const cmd = compassCommand('orders', { filter: { email: '<string>' }, sort: { createdAt: '<number>' } }, { placeholder: true });
    expect(cmd).toBe('db.getCollection("orders").find({ email: <email> }).sort({ createdAt: <number> }).explain("executionStats")');
    expect(cmd).toContain('<email>');
  });

  it('find with no sort has no .sort', () => {
    expect(compassCommand('orders', { filter: { status: '<string>' } }, { placeholder: true }))
      .toBe('db.getCollection("orders").find({ status: <status> }).explain("executionStats")');
  });

  it('a missing filter is {}; an old "<undefined>" sort is ignored', () => {
    expect(compassCommand('orders', { sort: '<undefined>' }, { placeholder: true }))
      .toBe('db.getCollection("orders").find({}).explain("executionStats")');
  });

  it('aggregate', () => {
    expect(compassCommand('orders', { pipeline: [{ $match: { email: '<string>' } }, { $limit: '<number>' }] }, { placeholder: true }))
      .toBe('db.getCollection("orders").aggregate([{ $match: { email: <email> } }, { $limit: <number> }]).explain("executionStats")');
  });

  it('escapes the collection name safely', () => {
    expect(compassCommand('or"d\\ers', { filter: {} }, { placeholder: true }))
      .toBe('db.getCollection("or\\"d\\\\ers").find({}).explain("executionStats")');
  });
});

describe('compassCommand (real values from a decrypted EJSON sample)', () => {
  const text = JSON.stringify({
    filter: {
      _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' },
      createdAt: { $gte: { $date: '2026-10-01T00:00:00.000Z' } },
      name: { $regex: 'ali', $options: 'i' },
      price: { $numberDecimal: '9.99' },
      views: { $numberLong: '9007199254740993' },
      blob: { $binary: { base64: 'AQID', subType: '00' } },
      email: 'a"li@example.com',
      score: { $numberDouble: 'Infinity' },
    },
    sort: { createdAt: -1 },
  });

  it('renders mongosh literals', () => {
    const cmd = compassCommand('users', parseRealSample(text)!, { placeholder: false });
    expect(cmd).toContain('_id: ObjectId("64b7f0c2a1b2c3d4e5f60718")');
    expect(cmd).toContain('createdAt: { $gte: ISODate("2026-10-01T00:00:00.000Z") }');
    expect(cmd).toContain('name: /ali/i');
    expect(cmd).toContain('price: NumberDecimal("9.99")');
    expect(cmd).toContain('views: NumberLong("9007199254740993")');
    expect(cmd).toContain('blob: BinData(0, "AQID")');
    expect(cmd).toContain('email: "a\\"li@example.com"');
    expect(cmd).toContain('score: Infinity');
    expect(cmd).toContain('.sort({ createdAt: -1 })');
    expect(cmd.startsWith('db.getCollection("users").find({ ')).toBe(true);
    expect(cmd.endsWith('.explain("executionStats")')).toBe(true);
  });

  it('a regex containing / stays a valid literal', () => {
    const cmd = compassCommand('users', parseRealSample(JSON.stringify({ filter: { path: { $regex: '^/api/v1', $options: '' } } }))!, { placeholder: false });
    const literal = /path: (\/.*\/[a-z]*) \}/.exec(cmd)![1]!;
    // The literal parses, and means the same pattern.
    const re = new Function(`return ${literal}`)() as RegExp;
    expect(re.test('/api/v1/users')).toBe(true);
    expect(re.test('x/api/v1')).toBe(false);
  });

  it('a pattern JavaScript cannot parse falls back to the $regex operator', () => {
    const cmd = compassCommand('users', parseRealSample(JSON.stringify({ filter: { n: { $regex: '(?i)a', $options: 'x' } } }))!, { placeholder: false });
    expect(cmd).toContain('n: { $regex: "(?i)a", $options: "x" }');
  });

  it('a mongoose string sort becomes a sort document', () => {
    const cmd = compassCommand('users', parseRealSample(JSON.stringify({ filter: {}, sort: '-createdAt name' }))!, { placeholder: false });
    expect(cmd).toContain('.sort({ createdAt: -1, name: 1 })');
  });

  it('aggregate with real values', () => {
    const cmd = compassCommand('users', parseRealSample(JSON.stringify({ pipeline: [{ $match: { at: { $date: '2026-01-01T00:00:00.000Z' } } }] }))!, { placeholder: false });
    expect(cmd).toBe('db.getCollection("users").aggregate([{ $match: { at: ISODate("2026-01-01T00:00:00.000Z") } }]).explain("executionStats")');
  });

  it('parseRealSample returns null for text that is not a sample object', () => {
    expect(parseRealSample('not json')).toBeNull();
    expect(parseRealSample('[1,2]')).toBeNull();
    expect(parseRealSample('null')).toBeNull();
  });

  it('a field named __proto__ is quoted and kept, not dropped as a prototype setter', () => {
    const cmd = compassCommand('users', parseRealSample('{"filter":{"__proto__":1,"a":2}}')!, { placeholder: false });
    expect(cmd).toBe('db.getCollection("users").find({ "__proto__": 1, a: 2 }).explain("executionStats")');
  });

  it('a __proto__ sort field survives the string-sort conversion', () => {
    const cmd = compassCommand('users', parseRealSample(JSON.stringify({ filter: {}, sort: '-__proto__ a' }))!, { placeholder: false });
    expect(cmd).toContain('.sort({ "__proto__": -1, a: 1 })');
  });

  it('placeholder mode quotes a __proto__ key too', () => {
    expect(placeholderize(JSON.parse('{"__proto__":"<string>","a":"<number>"}'))).toBe('{ "__proto__": <__proto__>, a: <number> }');
  });
});
