/**
 * Maps a MongoDB driver command (from command monitoring) to statements that
 * use the operation names and shapes of SDK 0.2, so signatures and hashes stay
 * stable. Pure: imports nothing, never throws.
 *
 * Privacy: sampleInput is built only from named command fields. The command
 * itself is never returned or kept.
 */

export interface MappedStatement {
  database: string;
  collection: string;
  /** The 0.2 operation name. */
  operation: string;
  filter?: unknown;
  /** Always a plain object, never a Map. */
  sort?: unknown;
  pipeline?: unknown[];
  /** Exactly the object 0.2 handed to redact(); null for insert. */
  sampleInput: Record<string, unknown> | null;
}

export const CAPTURED_COMMANDS: ReadonlySet<string> = new Set([
  'find',
  'aggregate',
  'insert',
  'update',
  'delete',
  'findAndModify',
  'count',
  'distinct',
  'bulkWrite',
]);

const IGNORED_DATABASES: ReadonlySet<string> = new Set(['admin', 'local', 'config']);

export function isIgnoredDatabase(database: string): boolean {
  return IGNORED_DATABASES.has(database);
}

export function toPlainSort(sort: unknown): unknown {
  return sort instanceof Map ? Object.fromEntries(sort) : sort;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasDollarKey(v: unknown): boolean {
  return isRecord(v) && Object.keys(v).some((k) => k.startsWith('$'));
}

/** True for `[{ $match }, ({ $skip })?, ({ $limit })?, { $group: { _id: 1, n: { $sum: 1 } } }]`. */
export function isCountDocumentsPipeline(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline) || pipeline.length < 2 || pipeline.length > 4) return false;
  const single = (stage: unknown): string | null => {
    if (!isRecord(stage)) return null;
    const keys = Object.keys(stage);
    return keys.length === 1 ? keys[0]! : null;
  };
  if (single(pipeline[0]) !== '$match') return false;
  let i = 1;
  if (i < pipeline.length - 1 && single(pipeline[i]) === '$skip') i++;
  if (i < pipeline.length - 1 && single(pipeline[i]) === '$limit') i++;
  if (i !== pipeline.length - 1) return false;
  const last = pipeline[i];
  if (single(last) !== '$group') return false;
  const group = (last as Record<string, unknown>).$group;
  if (!isRecord(group)) return false;
  const gk = Object.keys(group);
  if (gk.length !== 2 || group._id !== 1 || !isRecord(group.n)) return false;
  const n = group.n;
  return Object.keys(n).length === 1 && n.$sum === 1;
}

/** Drops keys whose value is undefined, as 0.2's sample did. */
function sample(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function stmt(
  database: string,
  collection: string,
  operation: string,
  fields: { filter?: unknown; sort?: unknown; pipeline?: unknown[] },
  sampleInput: Record<string, unknown> | null,
): MappedStatement {
  const s: MappedStatement = { database, collection, operation, sampleInput };
  if (fields.filter !== undefined) s.filter = fields.filter;
  if (fields.sort !== undefined) s.sort = fields.sort;
  if (fields.pipeline !== undefined) s.pipeline = fields.pipeline;
  return s;
}

function updateStatement(
  database: string,
  collection: string,
  filter: unknown,
  update: unknown,
  multi: unknown,
  rawSort: unknown,
): MappedStatement {
  const operation =
    multi === true ? 'updateMany' : isRecord(update) && !hasDollarKey(update) ? 'replaceOne' : 'updateOne';
  const sort = toPlainSort(rawSort);
  return stmt(database, collection, operation, { filter, sort }, sample({ filter, update, sort }));
}

function collectionName(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : '';
}

export function mapCommand(
  commandName: string,
  database: string,
  command: Record<string, unknown>,
): MappedStatement[] {
  try {
    if (commandName !== 'bulkWrite' && isIgnoredDatabase(database)) return [];
    switch (commandName) {
      case 'find': {
        const collection = collectionName(command.find);
        const filter = command.filter ?? {};
        const sort = toPlainSort(command.sort);
        const operation = command.limit === 1 && command.singleBatch === true ? 'findOne' : 'find';
        return [stmt(database, collection, operation, { filter, sort }, sample({ filter, sort }))];
      }
      case 'aggregate': {
        const collection = collectionName(command.aggregate);
        const pipeline = command.pipeline;
        if (isCountDocumentsPipeline(pipeline)) {
          const filter = ((pipeline as Record<string, unknown>[])[0] as { $match: unknown }).$match;
          return [stmt(database, collection, 'countDocuments', { filter }, sample({ filter }))];
        }
        const p = Array.isArray(pipeline) ? pipeline : undefined;
        return [stmt(database, collection, 'aggregate', { pipeline: p }, sample({ pipeline: p }))];
      }
      case 'update': {
        const collection = collectionName(command.update);
        const updates = Array.isArray(command.updates) ? command.updates : [];
        return updates.map((u: Record<string, unknown>) =>
          updateStatement(database, collection, u.q, u.u, u.multi, u.sort),
        );
      }
      case 'delete': {
        const collection = collectionName(command.delete);
        const deletes = Array.isArray(command.deletes) ? command.deletes : [];
        return deletes.map((d: Record<string, unknown>) =>
          stmt(database, collection, d.limit === 1 ? 'deleteOne' : 'deleteMany', { filter: d.q }, sample({ filter: d.q })),
        );
      }
      case 'findAndModify': {
        const collection = collectionName(command.findAndModify);
        const filter = command.query ?? {};
        const sort = toPlainSort(command.sort);
        if (command.remove === true) {
          return [stmt(database, collection, 'findOneAndDelete', { filter, sort }, sample({ filter, sort }))];
        }
        const update = command.update;
        const operation =
          Array.isArray(update) || hasDollarKey(update) ? 'findOneAndUpdate' : 'findOneAndReplace';
        return [stmt(database, collection, operation, { filter, sort }, sample({ filter, update, sort }))];
      }
      case 'count':
      case 'distinct': {
        const collection = collectionName(command[commandName]);
        const filter = command.query ?? {};
        return [stmt(database, collection, commandName, { filter }, sample({ filter }))];
      }
      case 'insert':
        return [stmt(database, collectionName(command.insert), 'insert', {}, null)];
      case 'bulkWrite': {
        const nsInfo = Array.isArray(command.nsInfo) ? command.nsInfo : [];
        const ops = Array.isArray(command.ops) ? command.ops : [];
        const out: MappedStatement[] = [];
        for (const op of ops as Record<string, unknown>[]) {
          const idx = typeof op.insert === 'number' ? op.insert : typeof op.update === 'number' ? op.update : op.delete;
          const ns = typeof idx === 'number' ? (nsInfo[idx] as { ns?: unknown } | undefined)?.ns : undefined;
          if (typeof ns !== 'string') continue;
          const dot = ns.indexOf('.');
          if (dot < 0) continue;
          const db = ns.slice(0, dot);
          const coll = ns.slice(dot + 1);
          if (isIgnoredDatabase(db)) continue;
          if (typeof op.insert === 'number') {
            out.push(stmt(db, coll, 'insert', {}, null));
          } else if (typeof op.update === 'number') {
            out.push(updateStatement(db, coll, op.filter, op.updateMods, op.multi, op.sort));
          } else if (typeof op.delete === 'number') {
            out.push(
              stmt(db, coll, op.multi === true ? 'deleteMany' : 'deleteOne', { filter: op.filter }, sample({ filter: op.filter })),
            );
          }
        }
        return out;
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}
