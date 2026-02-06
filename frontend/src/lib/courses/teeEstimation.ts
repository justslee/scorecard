import type { LngLat } from './greenDetection';

export type TeeEstimate = {
  holeNumber: number;
  teeSet: string;
  tee: LngLat;
  yards: number;
};

function toRad(d: number) {
  return (d * Math.PI) / 180;
}
function toDeg(r: number) {
  return (r * 180) / Math.PI;
}

// Destination point given start, bearing (deg), distance (m)
function destination(start: LngLat, bearingDeg: number, distanceM: number): LngLat {
  const R = 6371000;
  const br = toRad(bearingDeg);
  const lat1 = toRad(start.lat);
  const lon1 = toRad(start.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distanceM / R) +
      Math.cos(lat1) * Math.sin(distanceM / R) * Math.cos(br)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(distanceM / R) * Math.cos(lat1),
      Math.cos(distanceM / R) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: toDeg(lat2), lng: toDeg(lon2) };
}

function bearingDeg(from: LngLat, to: LngLat) {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lng - from.lng);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = Math.atan2(y, x);
  return (toDeg(brng) + 360) % 360;
}

export function estimateTees(params: {
  sequencedGreens: Array<{ holeNumber: number; green: LngLat }>;
  yardagesByHole: Array<{ holeNumber: number; yardages: Record<string, number> }>;
  teeSetNames: string[];
}): TeeEstimate[] {
  const { sequencedGreens, yardagesByHole, teeSetNames } = params;
  const greenByHole = new Map(sequencedGreens.map((h) => [h.holeNumber, h.green]));
  const yardByHole = new Map(yardagesByHole.map((h) => [h.holeNumber, h.yardages]));

  const out: TeeEstimate[] = [];

  for (const hole of sequencedGreens) {
    const g = hole.green;
    const prev = greenByHole.get(hole.holeNumber - 1);
    const next = greenByHole.get(hole.holeNumber + 1);

    // Direction heuristic:
    // - for hole 1: use 1->2 direction (walk from 1 green to 2 green)
    // - else: use prev->current
    const dirFrom = hole.holeNumber === 1 ? g : prev || g;
    const dirTo = hole.holeNumber === 1 ? next || g : g;

    // We want tee behind the green along opposite of travel direction
    const br = bearingDeg(dirFrom, dirTo);
    const backBearing = (br + 180) % 360;

    const yardages = yardByHole.get(hole.holeNumber) || {};
    for (const teeSet of teeSetNames) {
      const yards = Number(yardages[teeSet] || 0);
      if (!yards) continue;
      const distanceM = yards * 0.9144;
      const tee = destination(g, backBearing, distanceM);
      out.push({ holeNumber: hole.holeNumber, teeSet, tee, yards });
    }
  }

  return out;
}
