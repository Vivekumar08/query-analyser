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

  // A field can appear in more than one of {equality, sort, range} — most
  // commonly "filter on a date range and sort by that same date", but also
  // "equality-match a field and (redundantly) sort by it". Each field may
  // occupy exactly one slot in the index key, so every push below first
  // checks whether the field is already present rather than appending again.
  //
  // Direction precedence is deliberate, not an accident of loop order:
  //   - An equality match constrains the field to a fixed value (or a small
  //     `in` set), so the direction recorded for it is arbitrary — ascending
  //     vs. descending makes no difference to how the index serves an
  //     equality predicate. Equality fields are pushed first, which is also
  //     where Equality–Sort–Range puts them.
  //   - A sort key's direction is exactly what lets the index serve the
  //     `ORDER BY` without a separate in-memory sort, so when a field is
  //     *also* a sort key, the sort's direction wins and overwrites whatever
  //     direction an earlier equality push recorded. The field keeps its
  //     earlier (equality) position — the position is already correct for
  //     ESR, only the direction needs to come from the sort.
  //   - A range predicate on a field that is also the sort key is the
  //     mainline case this fix targets: scanning the index in the sort's
  //     direction over the range bounds serves both the filter and the
  //     `ORDER BY` in one pass, so the field is recorded once, in the Sort
  //     position, with the sort's direction — the range loop is a no-op for
  //     a field it has already seen.
  const suggestion: SuggestionField[] = [];
  const position = new Map<string, number>();

  const upsert = (field: string, dir: 1 | -1, dirWins: boolean): void => {
    const idx = position.get(field);
    if (idx === undefined) {
      position.set(field, suggestion.length);
      suggestion.push({ field, dir });
    } else if (dirWins) {
      suggestion[idx]!.dir = dir;
    }
  };

  for (const f of equality) if (f.key !== '_id') upsert(f.key, 1, false);
  for (const s of sortKeys) upsert(s.key, s.dir, true);
  for (const f of range) if (f.key !== '_id') upsert(f.key, 1, false);

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
