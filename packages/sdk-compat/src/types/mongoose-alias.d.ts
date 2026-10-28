// Type shim for the `mongooseN` npm aliases. Mongoose ships its types as an
// ambient `declare module 'mongoose'`, which an alias name can't import, and
// loading several majors would merge conflicting declarations. tsconfig
// `paths` maps every alias here, and `mongoose` itself to the Mongoose 8
// types, so test code is typed against one copy. Runtime is unaffected: each
// alias still loads its own major.
export * from 'mongoose';
export { default } from 'mongoose';
