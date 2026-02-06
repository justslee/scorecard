import type { LngLat, GreenCandidate } from './greenDetection';

export type SequencedHole = {
  holeNumber: number;
  green: LngLat;
  sourceId?: string;
};

function dist2(a: LngLat, b: LngLat) {
  // quick planar-ish in degrees, ok for ordering
  const dx = a.lng - b.lng;
  const dy = a.lat - b.lat;
  return dx * dx + dy * dy;
}

function segmentsCross(a1: LngLat, a2: LngLat, b1: LngLat, b2: LngLat) {
  // 2D segment intersection using orientation
  const orient = (p: LngLat, q: LngLat, r: LngLat) => {
    const v = (q.lat - p.lat) * (r.lng - q.lng) - (q.lng - p.lng) * (r.lat - q.lat);
    if (Math.abs(v) < 1e-12) return 0;
    return v > 0 ? 1 : 2;
  };
  const onSeg = (p: LngLat, q: LngLat, r: LngLat) => {
    return (
      Math.min(p.lng, r.lng) <= q.lng &&
      q.lng <= Math.max(p.lng, r.lng) &&
      Math.min(p.lat, r.lat) <= q.lat &&
      q.lat <= Math.max(p.lat, r.lat)
    );
  };

  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(a1, b1, a2)) return true;
  if (o2 === 0 && onSeg(a1, b2, a2)) return true;
  if (o3 === 0 && onSeg(b1, a1, b2)) return true;
  if (o4 === 0 && onSeg(b1, a2, b2)) return true;
  return false;
}

function twoOpt(path: LngLat[], iterations = 200) {
  if (path.length < 4) return path;
  const p = [...path];
  for (let it = 0; it < iterations; it++) {
    let improved = false;
    for (let i = 1; i < p.length - 2; i++) {
      for (let k = i + 1; k < p.length - 1; k++) {
        const a1 = p[i - 1],
          a2 = p[i];
        const b1 = p[k],
          b2 = p[k + 1];
        // If edges cross, reversing helps
        if (segmentsCross(a1, a2, b1, b2)) {
          const reversed = p.slice(i, k + 1).reverse();
          p.splice(i, k - i + 1, ...reversed);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return p;
}

export function sequenceHolesFromGreens(greens: Array<LngLat | GreenCandidate>, holeCount = 18): SequencedHole[] {
  const pts: Array<{ p: LngLat; id?: string }> = greens
    .map((g) => ('center' in g ? { p: g.center, id: g.id } : { p: g }))
    .slice(0, holeCount);

  if (!pts.length) return [];

  // Start at SW-most (often near clubhouse/parking but not guaranteed)
  let startIdx = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i].p;
    const b = pts[startIdx].p;
    if (a.lat + a.lng < b.lat + b.lng) startIdx = i;
  }

  const unvisited = pts.map((_, i) => i).filter((i) => i !== startIdx);
  const pathIdx = [startIdx];

  while (unvisited.length) {
    const last = pts[pathIdx[pathIdx.length - 1]].p;
    let bestJ = 0;
    let bestD = Infinity;
    for (let j = 0; j < unvisited.length; j++) {
      const cand = pts[unvisited[j]].p;
      const d = dist2(last, cand);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    pathIdx.push(unvisited.splice(bestJ, 1)[0]);
  }

  // De-cross with 2-opt
  const path = twoOpt(pathIdx.map((i) => pts[i].p));

  return path.slice(0, holeCount).map((p, idx) => ({ holeNumber: idx + 1, green: p }));
}
