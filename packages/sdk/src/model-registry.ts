/**
 * Resolves a driver namespace (db, collection) to a Mongoose model name using
 * only Mongoose's public registry. Mongoose is typed structurally and never
 * imported. Every property read is guarded; resolve() never throws.
 */

export interface ModelResolver {
  /** The model name for this namespace, or the collection name when none matches. Never throws. */
  resolve(database: string, collection: string, filter: unknown): string;
  /** Models registered across every reachable connection right now. */
  modelCount(): number;
}

interface Discriminator {
  key: string;
  value: string;
  name: string;
}

interface NamespaceEntry {
  base?: string;
  discriminators: Discriminator[];
}

interface Index {
  namespaces: Map<string, NamespaceEntry>;
  /** collection name -> names of base models registered under it, any db. */
  collections: Map<string, Set<string>>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Every reachable connection: mongoose.connections plus each one's otherDbs. */
function listConnections(mongoose: object | null): unknown[] {
  const out: unknown[] = [];
  if (!mongoose) return out;
  try {
    const conns = (mongoose as { connections?: unknown }).connections;
    if (!Array.isArray(conns)) return out;
    for (const c of conns) {
      if (!c || typeof c !== 'object') continue;
      out.push(c);
      try {
        const others = (c as { otherDbs?: unknown }).otherDbs;
        if (Array.isArray(others)) {
          for (const o of others) if (o && typeof o === 'object') out.push(o);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function listModels(conn: unknown): unknown[] {
  try {
    const models = (conn as { models?: unknown }).models;
    if (!models || typeof models !== 'object') return [];
    return Object.keys(models).map((k) => {
      try {
        return (models as Record<string, unknown>)[k];
      } catch {
        return null;
      }
    });
  } catch {
    return [];
  }
}

function countModels(mongoose: object | null): number {
  let n = 0;
  for (const c of listConnections(mongoose)) n += listModels(c).length;
  return n;
}

function build(mongoose: object | null): Index {
  const namespaces = new Map<string, NamespaceEntry>();
  const collections = new Map<string, Set<string>>();
  for (const c of listConnections(mongoose)) {
    for (const model of listModels(c)) {
      try {
        if (!model) continue;
        const m = model as {
          modelName?: unknown;
          db?: { name?: unknown };
          collection?: { collectionName?: unknown };
          baseModelName?: unknown;
          schema?: { discriminatorMapping?: { key?: unknown; value?: unknown } };
        };
        const name = str(m.modelName);
        const db = str(m.db?.name);
        const coll = str(m.collection?.collectionName);
        if (name === null || db === null || coll === null) continue;
        const nsKey = `${db}\u0000${coll}`;
        let entry = namespaces.get(nsKey);
        if (!entry) {
          entry = { discriminators: [] };
          namespaces.set(nsKey, entry);
        }
        if (typeof m.baseModelName === 'string') {
          const mapping = m.schema?.discriminatorMapping;
          entry.discriminators.push({
            key: str(mapping?.key) ?? '__t',
            value: str(mapping?.value) ?? name,
            name,
          });
        } else {
          if (entry.base === undefined) entry.base = name;
          let names = collections.get(coll);
          if (!names) {
            names = new Set();
            collections.set(coll, names);
          }
          names.add(name);
        }
      } catch {
        /* skip a model whose properties throw */
      }
    }
  }
  return { namespaces, collections };
}

export function createModelResolver(mongoose: object | null): ModelResolver {
  let index: Index | null = null;
  let builtCount = -1;

  const rebuild = (): void => {
    const count = countModels(mongoose);
    index = build(mongoose);
    builtCount = count;
  };

  const lookup = (database: string, collection: string, filter: unknown): string | null => {
    if (!index) return null;
    const entry = index.namespaces.get(`${database}\u0000${collection}`);
    if (entry && entry.base !== undefined) {
      if (filter && typeof filter === 'object' && !Array.isArray(filter)) {
        for (const d of entry.discriminators) {
          let v: unknown;
          try {
            v = (filter as Record<string, unknown>)[d.key];
          } catch {
            continue;
          }
          if (typeof v === 'string' && v === d.value) return d.name;
        }
      }
      return entry.base;
    }
    const names = index.collections.get(collection);
    if (names && names.size === 1) return names.values().next().value as string;
    return null;
  };

  return {
    resolve(database, collection, filter) {
      try {
        if (!mongoose) return collection;
        if (!index) rebuild();
        const hit = lookup(database, collection, filter);
        if (hit !== null) return hit;
        if (countModels(mongoose) !== builtCount) {
          rebuild();
          const again = lookup(database, collection, filter);
          if (again !== null) return again;
        }
        return collection;
      } catch {
        return collection;
      }
    },
    modelCount() {
      try {
        return countModels(mongoose);
      } catch {
        return 0;
      }
    },
  };
}
