import * as turf from '@turf/turf';
import type { CourseData, FeatureType } from './types';
import type { CourseCoordinates } from '@/lib/golf-api';

function isFeatureType(f: GeoJSON.Feature, t: FeatureType) {
  return (f.properties as any)?.featureType === t;
}

function toPointLike(feature: GeoJSON.Feature): { lat: number; lng: number } | null {
  try {
    if (!feature.geometry) return null;
    if (feature.geometry.type === 'Point') {
      const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
      return { lat, lng };
    }
    if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
      const c = turf.centroid(feature as any);
      const [lng, lat] = c.geometry.coordinates;
      return { lat, lng };
    }
    return null;
  } catch {
    return null;
  }
}

function polygonFrontBack(
  poly: GeoJSON.Feature,
  tee: { lat: number; lng: number } | null
): { front?: { lat: number; lng: number }; back?: { lat: number; lng: number } } {
  if (!tee) return {};
  if (poly.geometry.type !== 'Polygon' && poly.geometry.type !== 'MultiPolygon') return {};

  const centroid = toPointLike(poly);
  if (!centroid) return {};

  const v = {
    x: centroid.lng - tee.lng,
    y: centroid.lat - tee.lat,
  };
  const vLen2 = v.x * v.x + v.y * v.y;
  if (vLen2 === 0) return {};

  // Flatten polygon coordinates to a set of points
  const pts: Array<{ lat: number; lng: number }> = [];
  const geom: any = poly.geometry;
  const polys: number[][][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      for (const coord of ring) {
        pts.push({ lng: coord[0], lat: coord[1] });
      }
    }
  }
  if (pts.length === 0) return {};

  const proj = (p: { lat: number; lng: number }) => {
    const px = p.lng - tee.lng;
    const py = p.lat - tee.lat;
    return (px * v.x + py * v.y) / Math.sqrt(vLen2);
  };

  let minP = pts[0];
  let maxP = pts[0];
  let minT = proj(minP);
  let maxT = minT;

  for (const p of pts) {
    const t = proj(p);
    if (t < minT) {
      minT = t;
      minP = p;
    }
    if (t > maxT) {
      maxT = t;
      maxP = p;
    }
  }

  return { front: minP, back: maxP };
}

export function courseToCoordinates(
  course: CourseData,
  teeSetName?: string
): CourseCoordinates[] {
  return course.holes.map((h) => {
    const features = h.features?.features || [];

    const pinFeature = features.find((f) => isFeatureType(f, 'pin'));
    const greenFeature = features.find((f) => isFeatureType(f, 'green'));
    const pinPoint = pinFeature ? toPointLike(pinFeature) : null;

    const teeFeature = teeSetName
      ? features.find((f) => isFeatureType(f, 'tee') && (f.properties as any)?.teeSet === teeSetName)
      : features.find((f) => isFeatureType(f, 'tee'));

    const teePoint = teeFeature ? toPointLike(teeFeature) : null;
    const greenPoint = greenFeature ? toPointLike(greenFeature) : null;

    const fb = greenFeature ? polygonFrontBack(greenFeature, teePoint) : {};

    const hazards = features
      .filter((f) => {
        const t = (f.properties as any)?.featureType as FeatureType | undefined;
        return t && ['bunker', 'water', 'ob', 'target'].includes(t);
      })
      .map((f) => {
        const pt = toPointLike(f);
        const t = (f.properties as any)?.featureType as string;
        if (!pt) return null;
        return { type: t, lat: pt.lat, lng: pt.lng };
      })
      .filter(Boolean) as NonNullable<CourseCoordinates['hazards']>;

    return {
      holeNumber: h.number,
      green: greenPoint || pinPoint || { lat: 0, lng: 0 },
      pin: pinPoint || undefined,
      tee: teePoint || undefined,
      front: fb.front,
      back: fb.back,
      hazards,
    };
  });
}
