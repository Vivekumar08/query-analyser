// Words marked "reserved" (including "reserved (can be function or type)") in the
// PostgreSQL column of the PostgreSQL docs' Appendix C (SQL Key Words).
const PG_RESERVED = [
  'ALL', 'ANALYSE', 'ANALYZE', 'AND', 'ANY', 'ARRAY', 'AS', 'ASC', 'ASYMMETRIC', 'AUTHORIZATION', 'BINARY', 'BOTH',
  'CASE', 'CAST', 'CHECK', 'COLLATE', 'COLLATION', 'COLUMN', 'CONCURRENTLY', 'CONSTRAINT', 'CREATE', 'CROSS',
  'CURRENT_CATALOG', 'CURRENT_DATE', 'CURRENT_ROLE', 'CURRENT_SCHEMA', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER',
  'DEFAULT', 'DEFERRABLE', 'DESC', 'DISTINCT', 'DO', 'ELSE', 'END', 'EXCEPT', 'FALSE', 'FETCH', 'FOR', 'FOREIGN', 'FREEZE',
  'FROM', 'FULL', 'GRANT', 'GROUP', 'HAVING', 'ILIKE', 'IN', 'INITIALLY', 'INNER', 'INTERSECT', 'INTO', 'IS', 'ISNULL',
  'JOIN', 'LATERAL', 'LEADING', 'LEFT', 'LIKE', 'LIMIT', 'LOCALTIME', 'LOCALTIMESTAMP', 'NATURAL', 'NOT', 'NOTNULL', 'NULL',
  'OFFSET', 'ON', 'ONLY', 'OR', 'ORDER', 'OUTER', 'OVERLAPS', 'PLACING', 'PRIMARY', 'REFERENCES', 'RETURNING', 'RIGHT',
  'SELECT', 'SESSION_USER', 'SIMILAR', 'SOME', 'SYMMETRIC', 'SYSTEM_USER', 'TABLE', 'TABLESAMPLE', 'THEN', 'TO', 'TRAILING',
  'TRUE', 'UNION', 'UNIQUE', 'USER', 'USING', 'VARIADIC', 'VERBOSE', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
];

const EXTRA = [
  'BETWEEN', 'BY', 'CALL', 'CONFLICT', 'CROSS', 'DELETE', 'EXISTS', 'FILTER', 'FIRST', 'FULL', 'ILIKE', 'INNER', 'INSERT',
  'INTERVAL', 'IS', 'ISNULL', 'JOIN', 'LAST', 'LEFT', 'LIKE', 'LOCKED', 'MATCHED', 'MERGE', 'NATURAL', 'NOTHING', 'NOTNULL',
  'NULLS', 'OUTER', 'OVER', 'PARTITION', 'RECURSIVE', 'RIGHT', 'ROWS', 'SET', 'SHARE', 'SIMILAR', 'SKIP', 'UPDATE', 'VALUES',
  'ESCAPE',
];

/** Upper case. */
export const KEYWORDS: ReadonlySet<string> = new Set([...PG_RESERVED, ...EXTRA]);

/** Lower case; never masked. */
export const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper', 'length', 'now',
  'array_agg', 'json_agg', 'jsonb_agg', 'string_agg', 'row_number', 'rank', 'dense_rank', 'date_trunc', 'extract', 'unnest',
  'jsonb_build_object', 'json_build_object', 'to_char', 'to_timestamp', 'abs', 'round', 'floor', 'ceil', 'random',
  'gen_random_uuid', 'concat', 'substring', 'position', 'trim',
]);

/** Upper case statement verbs that are fingerprinted. */
export const CAPTURED_VERBS: ReadonlySet<string> = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'VALUES', 'TABLE', 'CALL',
]);
