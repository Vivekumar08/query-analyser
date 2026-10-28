import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createModelResolver } from './model-registry';
import { buildGoldenModels } from './__tests__/golden-cases';

interface FakeModel {
  modelName: string;
  db: { name: string };
  collection: { collectionName: string };
  baseModelName?: string;
  schema?: { discriminatorMapping?: { key?: string; value?: string } };
}
function m(modelName: string, db: string, coll: string, extra: Partial<FakeModel> = {}): FakeModel {
  return { modelName, db: { name: db }, collection: { collectionName: coll }, ...extra };
}
function conn(models: FakeModel[], otherDbs?: unknown) {
  const o: Record<string, unknown> = { models: Object.fromEntries(models.map((x, i) => [`${x.modelName}${i}`, x])) };
  if (otherDbs !== undefined) o.otherDbs = otherDbs;
  return o;
}
const fakeMongoose = (conns: unknown[]) => ({ connections: conns });

describe('createModelResolver', () => {
  it('resolves (db, collection) to the model name across connections', () => {
    const r = createModelResolver(
      fakeMongoose([
        conn([m('User', 'app', 'users')]),
        conn([m('Event', 'analytics', 'events'), m('AnalyticsUser', 'analytics', 'users')]),
      ]),
    );
    expect(r.resolve('app', 'users', {})).toBe('User');
    expect(r.resolve('analytics', 'events', {})).toBe('Event');
    expect(r.resolve('analytics', 'users', {})).toBe('AnalyticsUser');
    expect(r.modelCount()).toBe(3);
  });

  it('uses explicit collection names', () => {
    const r = createModelResolver(fakeMongoose([conn([m('Thing', 'app', 'my_things')])]));
    expect(r.resolve('app', 'my_things', {})).toBe('Thing');
  });

  it('walks useDb() connections in conn.otherDbs', () => {
    const tenant = conn([m('B', 'tenant_a', 'shared')]);
    const r = createModelResolver(fakeMongoose([{ ...conn([m('A', 'app', 'shared')]), otherDbs: [tenant] }]));
    expect(r.resolve('app', 'shared', {})).toBe('A');
    expect(r.resolve('tenant_a', 'shared', {})).toBe('B');
  });

  it('falls back to the collection alone when every model on it has one name', () => {
    const r = createModelResolver(fakeMongoose([conn([m('User', 'app', 'users'), m('User', 'tenant_a', 'users')])]));
    expect(r.resolve('tenant_b', 'users', {})).toBe('User');
  });

  it('returns the collection name when models on that collection have different names', () => {
    const r = createModelResolver(fakeMongoose([conn([m('A', 'app', 'shared'), m('B', 'tenant_a', 'shared')])]));
    expect(r.resolve('tenant_b', 'shared', {})).toBe('shared');
  });

  it('tolerates a missing or non-array otherDbs and throwing connection getters', () => {
    const throwing = {
      get models(): never {
        throw new Error('boom');
      },
      get otherDbs(): never {
        throw new Error('boom');
      },
    };
    const r = createModelResolver(
      fakeMongoose([conn([m('X', 'app', 'x')], 'nope'), conn([m('Y', 'app', 'y')], { a: 1 }), conn([]), throwing, null]),
    );
    expect(() => r.resolve('app', 'zzz', {})).not.toThrow();
    expect(r.resolve('app', 'zzz', {})).toBe('zzz');
    expect(r.resolve('app', 'x', {})).toBe('X');
    const bad = createModelResolver({ get connections(): never { throw new Error('x'); } });
    expect(bad.resolve('app', 'c', {})).toBe('c');
    expect(bad.modelCount()).toBe(0);
  });

  it('skips a model whose collection getter throws and still resolves the others', () => {
    const middle = { modelName: 'Middle', db: { name: 'app' }, get collection(): never { throw new Error('boom'); } };
    const c = { models: { First: m('First', 'app', 'first'), Middle: middle, Last: m('Last', 'app', 'last') } };
    const r = createModelResolver(fakeMongoose([c]));
    expect(r.resolve('app', 'first', {})).toBe('First');
    expect(r.resolve('app', 'last', {})).toBe('Last');
    expect(r.resolve('app', 'middle', {})).toBe('middle');
  });

  it('picks a discriminator from the filter, else the base model', () => {
    const r = createModelResolver(
      fakeMongoose([
        conn([
          m('Animal', 'app', 'animals'),
          m('Dog', 'app', 'animals', { baseModelName: 'Animal', schema: { discriminatorMapping: { key: '__t', value: 'Dog' } } }),
          m('Pet', 'app', 'pets'),
          m('Cat', 'app', 'pets', { baseModelName: 'Pet', schema: { discriminatorMapping: { key: 'kind', value: 'cat' } } }),
        ]),
      ]),
    );
    expect(r.resolve('app', 'animals', { __t: 'Dog', name: 'rex' })).toBe('Dog');
    expect(r.resolve('app', 'animals', { name: 'rex' })).toBe('Animal');
    expect(r.resolve('app', 'animals', { __t: 'Unknown' })).toBe('Animal');
    expect(r.resolve('app', 'animals', { __t: 5 })).toBe('Animal');
    expect(r.resolve('app', 'animals', null)).toBe('Animal');
    expect(r.resolve('app', 'animals', [1])).toBe('Animal');
    expect(r.resolve('app', 'pets', { kind: 'cat' })).toBe('Cat');
  });

  it('first-registered base model wins when two share a namespace', () => {
    const r = createModelResolver(fakeMongoose([conn([m('First', 'app', 'dup'), m('Second', 'app', 'dup')])]));
    expect(r.resolve('app', 'dup', {})).toBe('First');
  });

  it('returns the collection name with no mongoose', () => {
    expect(createModelResolver(null).resolve('app', 'orders', {})).toBe('orders');
  });

  it('rebuilds on a miss only when models were added', () => {
    const models: Record<string, FakeModel> = { A: m('A', 'app', 'a') };
    let reads = 0;
    const fake = {
      get connections() {
        reads++;
        return [{ models }];
      },
    };
    const r = createModelResolver(fake);
    expect(r.resolve('app', 'a', {})).toBe('A');
    const afterBuild = reads;
    r.resolve('app', 'nope', {});
    const afterFirstMiss = reads;
    r.resolve('app', 'nope', {});
    // second miss: one modelCount() read, no rebuild
    expect(reads - afterFirstMiss).toBe(1);
    expect(afterFirstMiss).toBeGreaterThan(afterBuild);
    models.B = m('B', 'app', 'b');
    expect(r.resolve('app', 'b', {})).toBe('B');
  });

  it('resolves real mongoose models, including discriminators', () => {
    const c = mongoose.createConnection();
    // An unconnected connection has no db name yet; give it one the way connect() would.
    (c as unknown as { name: string }).name = 'realdb';
    buildGoldenModels(c);
    const r = createModelResolver({ connections: [c] });
    const db = 'realdb';
    expect(r.resolve(db, 'my_things', {})).toBe('GoldenThing');
    expect(r.resolve(db, 'goldenusers', {})).toBe('GoldenUser');
    expect(r.resolve(db, 'goldenanimals', { __t: 'GoldenDog' })).toBe('GoldenDog');
    expect(r.resolve(db, 'goldenanimals', {})).toBe('GoldenAnimal');
  });
});
