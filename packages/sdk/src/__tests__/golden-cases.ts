import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface GoldenModels {
  User: Model<any>;
  Thing: Model<any>;
  Animal: Model<any>;
  Dog: Model<any>;
  Stamped: Model<any>;
}

export interface GoldenIds {
  userId: Types.ObjectId;
  spareId: Types.ObjectId;
}

export function buildGoldenModels(conn: mongoose.Connection): GoldenModels {
  const User = conn.model('GoldenUser', new Schema({ email: String, name: String, age: Number, tags: [String], address: { city: String }, createdAt: Date }));
  const Thing = conn.model('GoldenThing', new Schema({ a: Number }, { collection: 'my_things' }));
  const Animal = conn.model('GoldenAnimal', new Schema({ name: String, a: Number }));
  const Dog = Animal.discriminator('GoldenDog', new Schema({ breed: String }));
  const Stamped = conn.model('GoldenStamped', new Schema({ status: String }, { timestamps: true }));
  return { User, Thing, Animal, Dog, Stamped };
}

export async function seedGolden(m: GoldenModels): Promise<GoldenIds> {
  const a = await m.User.create({ email: 'a@x.test', age: 1 });
  const spare = await m.User.create({ email: 'spare@x.test' });
  await m.Dog.create({ name: 'rex' });
  return { userId: a._id, spareId: spare._id };
}

export const GOLDEN_FIELDS = ['signature', 'hash', 'model', 'operation', 'filterShape', 'sortKeys', 'stages', 'sample'] as const;

export const GOLDEN_CASES: ReadonlyArray<{ name: string; run(m: GoldenModels, ids: GoldenIds): Promise<unknown> }> = [
  { name: 'find-eq', run: (m) => m.User.find({ email: 'a@x.test' }).exec() },
  { name: 'find-range-sort', run: (m) => m.User.find({ age: { $gte: 18 } }).sort({ age: -1 }).exec() },
  { name: 'find-in', run: (m) => m.User.find({ email: { $in: ['a@x.test', 'b@x.test'] } }).exec() },
  { name: 'find-or', run: (m) => m.User.find({ $or: [{ email: 'a@x.test' }, { name: 'b' }] }).exec() },
  { name: 'find-regex', run: (m) => m.User.find({ name: /^an/i }).exec() },
  { name: 'find-exists-ne', run: (m) => m.User.find({ name: { $exists: true }, age: { $ne: 3 } }).exec() },
  { name: 'find-nested-path', run: (m) => m.User.find({ 'address.city': 'Pune' }).exec() },
  { name: 'find-string-sort', run: (m) => m.User.find({ age: 1 }).sort('-createdAt name').exec() },
  { name: 'find-limit-1', run: (m) => m.User.find({ age: 1 }).limit(1).exec() },
  { name: 'find-explicit-collection', run: (m) => m.Thing.find({ a: 1 }).exec() },
  { name: 'findOne', run: (m) => m.User.findOne({ email: 'a@x.test' }).exec() },
  { name: 'findOne-sort', run: (m) => m.User.findOne({ age: { $lt: 9 } }).sort({ age: 1 }).exec() },
  { name: 'findById', run: (m, ids) => m.User.findById(ids.userId).exec() },
  { name: 'exists', run: (m) => m.User.exists({ email: 'a@x.test' }).exec() },
  { name: 'countDocuments', run: (m) => m.User.countDocuments({ age: 1 }).exec() },
  { name: 'countDocuments-skip-limit', run: (m) => m.User.countDocuments({ age: 1 }).skip(1).limit(5).exec() },
  { name: 'distinct', run: (m) => m.User.distinct('name', { age: 1 }).exec() },
  { name: 'updateOne-set', run: (m) => m.User.updateOne({ email: 'a@x.test' }, { $set: { age: 2 } }).exec() },
  { name: 'updateMany-inc', run: (m) => m.User.updateMany({ age: 1 }, { $inc: { age: 1 } }).exec() },
  { name: 'updateOne-no-dollar', run: (m) => m.User.updateOne({ email: 'a@x.test' }, { age: 3 }).exec() },
  { name: 'updateOne-timestamps', run: (m) => m.Stamped.updateOne({ status: 'a' }, { $set: { status: 'b' } }).exec() },
  { name: 'replaceOne', run: (m) => m.User.replaceOne({ email: 'a@x.test' }, { email: 'a@x.test', age: 4 }).exec() },
  { name: 'deleteOne', run: (m) => m.User.deleteOne({ email: 'gone@x.test' }).exec() },
  { name: 'deleteMany', run: (m) => m.User.deleteMany({ age: { $gt: 1000 } }).exec() },
  { name: 'doc-deleteOne', run: async (m, ids) => await m.User.hydrate({ _id: ids.spareId, email: 'spare@x.test' }).deleteOne() },
  { name: 'findOneAndUpdate', run: (m) => m.User.findOneAndUpdate({ email: 'a@x.test' }, { $set: { age: 5 } }).exec() },
  { name: 'findByIdAndUpdate', run: (m, ids) => m.User.findByIdAndUpdate(ids.userId, { $inc: { age: 1 } }).exec() },
  { name: 'findOneAndUpdate-sort', run: (m) => m.User.findOneAndUpdate({ age: 1 }, { $set: { name: 'z' } }, { sort: { age: -1 } }).exec() },
  { name: 'findOneAndDelete', run: (m) => m.User.findOneAndDelete({ email: 'gone@x.test' }).exec() },
  { name: 'findOneAndReplace', run: (m) => m.User.findOneAndReplace({ email: 'a@x.test' }, { email: 'a@x.test', age: 6 }).exec() },
  { name: 'aggregate', run: (m) => m.User.aggregate([{ $match: { age: 1 } }, { $group: { _id: '$name', n: { $sum: 1 } } }]).exec() },
  { name: 'discriminator-find', run: (m) => m.Dog.find({ name: 'rex' }).exec() },
  { name: 'discriminator-findOne', run: (m) => m.Dog.findOne({ name: 'rex' }).exec() },
  { name: 'discriminator-updateMany', run: (m) => m.Dog.updateMany({ breed: 'lab' }, { $set: { name: 'max' } }).exec() },
  { name: 'discriminator-countDocuments', run: (m) => m.Dog.countDocuments({ name: 'rex' }).exec() },
];
