/**
 * hole-index — pure utility for building per-hole lookup indices.
 *
 * Extracted here so it can be unit-tested independently of any React component.
 * Used by InlineHoleDiagram to build O(1) hole→features maps from the once-fetched
 * mapped-course data, avoiding repeated iteration on every currentHole change.
 */

/**
 * Build a Map from hole number → T for any array of objects with a `number`
 * property.  Duplicates are last-wins (should not occur in well-formed course data).
 *
 * @param items - Array of objects with a numeric `number` field (HoleData, etc.)
 * @returns     Map from hole number to the item.
 */
export function indexByHoleNumber<T extends { number: number }>(
  items: T[],
): Map<number, T> {
  const index = new Map<number, T>();
  for (const item of items) {
    index.set(item.number, item);
  }
  return index;
}
