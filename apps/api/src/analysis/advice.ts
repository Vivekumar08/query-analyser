import type { FilterShapeItem, SortKey, OpClass } from '@query-analyser/contract/runtime';

export interface SuggestionField {
  field: string;
  dir: 1 | -1;
}

export interface AdviceSuggestion {
  /**
   * Array order matters — this IS the index key, not a set. A `jsonb` column
   * canonicalises object key order (by key length, then bytewise), so an
   * ordered index recommendation can never be stored as a plain object. An
   * array of `{ field, dir }` pairs makes the ordering explicit and
   * unloseable at every layer, including a future consumer that does not
   * preserve object key order itself.
   */
  suggestion: SuggestionField[];
  rationale: string;
}

const EQUALITY: OpClass[] = ['eq', 'in'];
/** `exists` is not an equality match on a value, so it sits with the ranges. */
const RANGE: OpClass[] = ['range', 'exists'];
const UNINDEXABLE: OpClass[] = ['regex', 'ne', 'other'];

/**
 * Deterministic Equality–Sort–Range index advice derived from query shape.
 *
 * The service has never seen the customer's indexes or collection statistics,
 * so the rationale says so. That honesty is what makes explain()-based
 * evidence a credible v2 rather than a contradiction of v1.
 */
export function adviceFor(
  filterShape: FilterShapeItem[],
  sortKeys: SortKey[],
): AdviceSuggestion | null {
  if (filterShape.length === 0 && sortKeys.length === 0) return null;

  const equality = filterShape.filter((f) => EQUALITY.includes(f.op));
  const range = filterShape.filter((f) => RANGE.includes(f.op));
  const excluded = filterShape.filter((f) => UNINDEXABLE.includes(f.op));

  const indexable = [...equality, ...range];
  // `_id` is always indexed; suggesting it is noise.
  const meaningful = indexable.filter((f) => f.key !== '_id');
  if (meaningful.length === 0 && sortKeys.length === 0) return null;

  const suggestion: SuggestionField[] = [];
  for (const f of equality) if (f.key !== '_id') suggestion.push({ field: f.key, dir: 1 });
  for (const s of sortKeys) suggestion.push({ field: s.key, dir: s.dir });
  for (const f of range) if (f.key !== '_id') suggestion.push({ field: f.key, dir: 1 });

  if (suggestion.length === 0) return null;

  const parts = [
    'Equality fields first, then the sort keys in their sort order, then range fields (Equality–Sort–Range).',
  ];
  if (excluded.length > 0) {
    parts.push(
      `Excluded as unindexable in this position: ${excluded.map((f) => `${f.key} (${f.op})`).join(', ')}.`,
    );
  }
  parts.push(
    'This is a heuristic derived from query shape — the service has never seen your indexes or collection statistics.',
  );

  return { suggestion, rationale: parts.join(' ') };
}
