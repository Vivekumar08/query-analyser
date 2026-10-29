import { describe, expect, it } from 'vitest';
import { CAPTURED_COMMANDS, isCountDocumentsPipeline, isIgnoredDatabase, mapCommand, toPlainSort } from './command-map.js';

const GROUP = { $group: { _id: 1, n: { $sum: 1 } } };

describe('mapCommand', () => {
  it('exports the captured set and ignored databases', () => {
    expect([...CAPTURED_COMMANDS].sort()).toEqual(
      ['aggregate', 'bulkWrite', 'count', 'delete', 'distinct', 'find', 'findAndModify', 'insert', 'update'],
    );
    expect(['admin', 'local', 'config'].every(isIgnoredDatabase)).toBe(true);
    expect(isIgnoredDatabase('app')).toBe(false);
  });

  it('toPlainSort converts a Map and passes anything else through', () => {
    expect(toPlainSort(new Map([['a', 1]]))).toEqual({ a: 1 });
    expect(toPlainSort({ a: 1 })).toEqual({ a: 1 });
    expect(toPlainSort(undefined)).toBeUndefined();
  });

  it('find: a Map sort becomes a plain object in both the sort and the sample', () =>
    expect(mapCommand('find', 'app', { find: 'users', filter: { a: 1 }, sort: new Map([['age', -1]]) })).toEqual([
      { database: 'app', collection: 'users', operation: 'find', filter: { a: 1 }, sort: { age: -1 }, sampleInput: { filter: { a: 1 }, sort: { age: -1 } } },
    ]));

  it('find: limit 1 with singleBatch is findOne; limit 1 alone stays find', () => {
    expect(mapCommand('find', 'app', { find: 'u', filter: {}, limit: 1, singleBatch: true })[0]!.operation).toBe('findOne');
    expect(mapCommand('find', 'app', { find: 'u', filter: {}, limit: 1 })[0]!.operation).toBe('find');
  });

  it('find with no filter uses {} like 0.2', () => {
    const [s] = mapCommand('find', 'app', { find: 'u' });
    expect(s!.filter).toEqual({});
    expect(s!.sampleInput).toEqual({ filter: {} });
    expect('sort' in s!.sampleInput!).toBe(false);
  });

  it.each([
    [[{ $match: { a: 1 } }, GROUP]],
    [[{ $match: { a: 1 } }, { $skip: 1 }, { $limit: 5 }, GROUP]],
    [[{ $match: { a: 1 } }, { $limit: 5 }, GROUP]],
  ])('countDocuments pipeline %#', (pipeline) =>
    expect(mapCommand('aggregate', 'app', { aggregate: 'users', pipeline })[0]).toEqual(
      { database: 'app', collection: 'users', operation: 'countDocuments', filter: { a: 1 }, sampleInput: { filter: { a: 1 } } }));

  it('a $group that is not the count shape stays an aggregate', () => {
    const pipeline = [{ $match: { a: 1 } }, { $group: { _id: null, n: { $sum: 1 } } }];
    expect(isCountDocumentsPipeline(pipeline)).toBe(false);
    expect(mapCommand('aggregate', 'app', { aggregate: 'users', pipeline })).toEqual([
      { database: 'app', collection: 'users', operation: 'aggregate', pipeline, sampleInput: { pipeline }, modelFilter: { a: 1 } },
    ]);
  });

  it('countDocuments pipeline rejects wrong order and multi-key stages', () => {
    expect(isCountDocumentsPipeline([{ $match: {} }, { $limit: 1 }, { $skip: 1 }, GROUP])).toBe(false);
    expect(isCountDocumentsPipeline([{ $match: {}, $x: 1 }, GROUP])).toBe(false);
    expect(isCountDocumentsPipeline('x')).toBe(false);
  });

  it('an aggregate carries the stage Mongoose puts the discriminator key in as modelFilter, and nothing else changes', () => {
    const pipeline = [{ $match: { name: 'rex', __t: 'Dog' } }, { $sort: { name: 1 } }];
    expect(mapCommand('aggregate', 'app', { aggregate: 'animals', pipeline })).toEqual([
      { database: 'app', collection: 'animals', operation: 'aggregate', pipeline, sampleInput: { pipeline },
        modelFilter: { name: 'rex', __t: 'Dog' } },
    ]);
    const near = { near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'd', query: { __t: 'Dog' } };
    expect(mapCommand('aggregate', 'app', { aggregate: 'animals', pipeline: [{ $geoNear: near }] })[0]!.modelFilter)
      .toEqual({ __t: 'Dog' });
    expect(mapCommand('aggregate', 'app', { aggregate: 'animals', pipeline: [{ $search: {} }, { $match: { __t: 'Dog' } }] })[0]!.modelFilter)
      .toEqual({ __t: 'Dog' });
    expect(mapCommand('aggregate', 'app', { aggregate: 'animals', pipeline: [{ $group: { _id: '$a' } }] })[0]).not.toHaveProperty('modelFilter');
  });

  it('aggregate: 1 gives an empty collection', () => {
    expect(mapCommand('aggregate', 'app', { aggregate: 1, pipeline: [{ $documents: [] }] })[0]!.collection).toBe('');
  });

  it('update statements: multi → updateMany, $-less object → replaceOne, pipeline array → updateOne', () => {
    const st = mapCommand('update', 'app', {
      update: 'users',
      updates: [
        { q: { a: 1 }, u: { $set: { b: 1 } }, multi: true },
        { q: { a: 2 }, u: { b: 2 } },
        { q: { a: 3 }, u: [{ $set: { b: 3 } }], sort: new Map([['a', 1]]) },
      ],
    });
    expect(st.map((s) => s!.operation)).toEqual(['updateMany', 'replaceOne', 'updateOne']);
    expect(st[0]!.sampleInput).toEqual({ filter: { a: 1 }, update: { $set: { b: 1 } } });
    expect(st[2]!.sampleInput).toEqual({ filter: { a: 3 }, update: [{ $set: { b: 3 } }], sort: { a: 1 } });
    expect(st[2]!.sort).toEqual({ a: 1 });
  });

  it('delete statements: limit 1 → deleteOne, else deleteMany', () => {
    const st = mapCommand('delete', 'app', { delete: 'users', deletes: [{ q: { a: 1 }, limit: 1 }, { q: { a: 2 }, limit: 0 }] });
    expect(st.map((s) => s!.operation)).toEqual(['deleteOne', 'deleteMany']);
    expect(st[1]!).toEqual({ database: 'app', collection: 'users', operation: 'deleteMany', filter: { a: 2 }, sampleInput: { filter: { a: 2 } } });
  });

  it('findAndModify: remove, $-update, pipeline update, replacement', () => {
    const run = (c: Record<string, unknown>) => mapCommand('findAndModify', 'app', { findAndModify: 'users', query: { a: 1 }, ...c })[0]!;
    const del = run({ remove: true });
    expect(del.operation).toBe('findOneAndDelete');
    expect('update' in del.sampleInput!).toBe(false);
    expect(run({ update: { $set: { b: 1 } } }).operation).toBe('findOneAndUpdate');
    expect(run({ update: [{ $set: { b: 1 } }] }).operation).toBe('findOneAndUpdate');
    const rep = run({ update: { b: 1 }, sort: new Map([['a', -1]]) });
    expect(rep.operation).toBe('findOneAndReplace');
    expect(rep.sampleInput).toEqual({ filter: { a: 1 }, update: { b: 1 }, sort: { a: -1 } });
  });

  it('count and distinct', () => {
    expect(mapCommand('count', 'app', { count: 'users', query: { a: 1 } })).toEqual([
      { database: 'app', collection: 'users', operation: 'count', filter: { a: 1 }, sampleInput: { filter: { a: 1 } } },
    ]);
    expect(mapCommand('distinct', 'app', { distinct: 'users', key: 'a' })[0]).toMatchObject({ operation: 'distinct', filter: {}, sampleInput: { filter: {} } });
  });

  it('insert has no shape and no sample', () =>
    expect(mapCommand('insert', 'app', { insert: 'users', documents: [{ email: 'x' }] })).toEqual(
      [{ database: 'app', collection: 'users', operation: 'insert', sampleInput: null }]));

  it('MongoClient.bulkWrite on admin maps each op to its own namespace and skips ignored ones', () => {
    const st = mapCommand('bulkWrite', 'admin', {
      bulkWrite: 1,
      nsInfo: [{ ns: 'shop.orders' }, { ns: 'local.x' }],
      ops: [
        { insert: 0, document: { a: 1 } },
        { update: 0, filter: { s: 1 }, updateMods: { $set: { s: 2 } }, multi: true },
        { update: 0, filter: { s: 1 }, updateMods: { s: 3 } },
        { delete: 0, filter: { s: 1 }, multi: false },
        { delete: 1, filter: {} },
      ],
    });
    expect(st.map((s) => `${s.database}.${s.collection}:${s!.operation}`)).toEqual(
      ['shop.orders:insert', 'shop.orders:updateMany', 'shop.orders:replaceOne', 'shop.orders:deleteOne']);
    expect(st[1]!.sampleInput).toEqual({ filter: { s: 1 }, update: { $set: { s: 2 } } });
    expect(st[0]!.sampleInput).toBeNull();
  });

  it('bulkWrite splits the namespace at the first dot and deleteMany on multi', () => {
    const [s] = mapCommand('bulkWrite', 'admin', { nsInfo: [{ ns: 'db.a.b' }], ops: [{ delete: 0, filter: {}, multi: true }] });
    expect(s).toMatchObject({ database: 'db', collection: 'a.b', operation: 'deleteMany' });
  });

  it('leaves undefined keys out of the sample', () => {
    const [s] = mapCommand('update', 'app', { update: 'u', updates: [{ q: { a: 1 }, u: { $set: { a: 2 } }, sort: undefined }] });
    expect(Object.keys(s!.sampleInput!)).toEqual(['filter', 'update']);
  });

  it.each(['hello', 'ping', 'getMore', 'killCursors', 'endSessions', 'createIndexes', 'explain'])('ignores %s', (name) =>
    expect(mapCommand(name, 'app', { [name]: 'users' })).toEqual([]));

  it.each(['admin', 'local', 'config'])('ignores a find on %s', (db) =>
    expect(mapCommand('find', db, { find: 'x', filter: {} })).toEqual([]));

  it('never throws on a hostile command', () => {
    const evil = { get find(): never { throw new Error('boom'); } };
    expect(mapCommand('find', 'app', evil)).toEqual([]);
  });

  it('does not put unrelated command fields in the sample', () => {
    const [s] = mapCommand('find', 'app', { find: 'u', filter: { a: 1 }, lsid: { id: 1 }, $clusterTime: {}, $db: 'app' });
    expect(Object.keys(s!.sampleInput!)).toEqual(['filter']);
  });
});
