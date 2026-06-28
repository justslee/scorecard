// The decorative "your shot lands here" marker for a hole diagram: the midpoint
// of the hole's LAST path segment, nudged slightly toward the green.
//
// Guards both endpoints — a par-3 has a 2-point path, and an earlier version
// indexed pathPts[length-1 + 1] (undefined) on hole 3 → "Cannot read properties
// of undefined (reading '0')" white-screen crash. Returns null when there's no
// usable segment.

export type PathPoint = [number, number];

export function shotPointForPath(path: PathPoint[]): PathPoint | null {
  const midIdx = Math.max(0, path.length - 2);
  const a = path[midIdx];
  const b = path[midIdx + 1];
  if (!a || !b) return null;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.05];
}
