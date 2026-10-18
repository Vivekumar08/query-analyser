/**
 * Serialises a raw query sample to Extended-JSON-like text, so a developer
 * can paste the decrypted result into MongoDB Compass.
 *
 * - ObjectId -> {"$oid"}, Date -> {"$date"}, RegExp -> {"$regex","$options"},
 *   Decimal128 -> {"$numberDecimal"}, Buffer/Uint8Array/Binary -> {"$binary"},
 *   Long/bigint -> {"$numberLong"}, non-finite numbers -> {"$numberDouble"};
 * - Map -> array of [key, value] pairs, Set -> array;
 * - a circular reference -> "<circular>" (a value shared but not circular is
 *   written in full each time).
 *
 * bson/mongoose types are detected by duck-typing `_bsontype`, so this module
 * imports nothing. It never throws: any failure, or output over `maxBytes`
 * of UTF-8, returns `null`.
 */

const CIRCULAR = '"<circular>"';

class OverBudget extends Error {}

type BsonLike = {
  _bsontype?: unknown;
  toHexString?: () => string;
  toString: () => string;
  buffer?: unknown;
  sub_type?: unknown;
  pattern?: unknown;
  options?: unknown;
  t?: unknown;
  i?: unknown;
  value?: unknown;
  valueOf?: () => unknown;
};

export function serializeSample(value: unknown, maxBytes = 16_384): string | null {
  try {
    const parts: string[] = [];
    // UTF-8 is at least one byte per UTF-16 code unit, so a running character
    // count is a lower bound on the byte length: stop as soon as it passes the
    // cap instead of serialising a huge value in full.
    let chars = 0;
    const emit = (s: string) => {
      chars += s.length;
      if (chars > maxBytes) throw new OverBudget();
      parts.push(s);
    };
    const ancestors = new Set<object>();

    const write = (v: unknown): void => {
      switch (typeof v) {
        case 'string': emit(JSON.stringify(v)); return;
        case 'boolean': emit(v ? 'true' : 'false'); return;
        case 'number':
          if (Number.isFinite(v)) emit(JSON.stringify(v));
          else emit(`{"$numberDouble":${JSON.stringify(String(v))}}`);
          return;
        case 'bigint': emit(`{"$numberLong":${JSON.stringify(v.toString())}}`); return;
        case 'undefined':
        case 'function':
        case 'symbol':
          emit('null'); return;
      }
      if (v === null) { emit('null'); return; }

      const obj = v as object;
      if (ancestors.has(obj)) { emit(CIRCULAR); return; }
      ancestors.add(obj);
      try {
        writeObject(obj);
      } finally {
        ancestors.delete(obj);
      }
    };

    const writeArray = (items: Iterable<unknown>): void => {
      emit('[');
      let first = true;
      for (const item of items) {
        if (!first) emit(',');
        first = false;
        write(item);
      }
      emit(']');
    };

    const writeBinary = (bytes: Uint8Array, subType: number): void => {
      const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
      const sub = subType.toString(16).padStart(2, '0');
      emit(`{"$binary":{"base64":${JSON.stringify(base64)},"subType":${JSON.stringify(sub)}}}`);
    };

    const writeObject = (obj: object): void => {
      const bson = obj as BsonLike;
      const kind = typeof bson._bsontype === 'string' ? bson._bsontype : undefined;
      if (kind !== undefined) {
        switch (kind) {
          case 'ObjectId':
          case 'ObjectID': {
            const hex = typeof bson.toHexString === 'function' ? bson.toHexString() : String(bson);
            emit(`{"$oid":${JSON.stringify(hex)}}`);
            return;
          }
          case 'Decimal128':
            emit(`{"$numberDecimal":${JSON.stringify(String(bson))}}`); return;
          case 'Long':
            emit(`{"$numberLong":${JSON.stringify(String(bson))}}`); return;
          case 'Int32':
          case 'Double':
            write(typeof bson.valueOf === 'function' ? bson.valueOf() : bson.value); return;
          case 'Binary':
            if (bson.buffer instanceof Uint8Array) {
              writeBinary(bson.buffer, typeof bson.sub_type === 'number' ? bson.sub_type : 0);
              return;
            }
            break;
          case 'BSONRegExp':
            emit(`{"$regex":${JSON.stringify(String(bson.pattern))},"$options":${JSON.stringify(String(bson.options ?? ''))}}`);
            return;
          case 'Timestamp':
            emit(`{"$timestamp":{"t":${Number(bson.t)},"i":${Number(bson.i)}}}`); return;
          case 'MinKey': emit('{"$minKey":1}'); return;
          case 'MaxKey': emit('{"$maxKey":1}'); return;
        }
        // Any other bson type: fall back to its string form.
        emit(JSON.stringify(String(bson)));
        return;
      }

      if (obj instanceof Date) {
        const t = obj.getTime();
        emit(Number.isNaN(t) ? '{"$date":null}' : `{"$date":${JSON.stringify(obj.toISOString())}}`);
        return;
      }
      if (obj instanceof RegExp) {
        emit(`{"$regex":${JSON.stringify(obj.source)},"$options":${JSON.stringify(obj.flags)}}`);
        return;
      }
      if (obj instanceof Uint8Array) { writeBinary(obj, 0); return; }
      if (obj instanceof Map) { writeArray(obj.entries()); return; }
      if (obj instanceof Set || Array.isArray(obj)) { writeArray(obj as Iterable<unknown>); return; }

      emit('{');
      let first = true;
      for (const key of Object.keys(obj)) {
        const field = (obj as Record<string, unknown>)[key];
        // Match JSON: keys whose value cannot be represented are omitted.
        if (field === undefined || typeof field === 'function' || typeof field === 'symbol') continue;
        if (!first) emit(',');
        first = false;
        emit(JSON.stringify(key));
        emit(':');
        write(field);
      }
      emit('}');
    };

    write(value);
    const text = parts.join('');
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  } catch {
    // Over budget, a throwing getter, stack exhaustion on absurd nesting:
    // the sample is skipped, never the query and never the batch.
    return null;
  }
}
