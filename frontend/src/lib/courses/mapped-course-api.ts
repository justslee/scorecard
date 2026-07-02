/**
 * Helpers for loading and rendering mapped (homegrown-geometry) courses stored
 * in the PostGIS course store via GET /api/courses/mapped/{id}.
 *
 * Converts the stored GeoJSON features (full polygon geometry, featureType +
 * hole number in properties) into the shapes consumed by GPSMapView:
 *   - ``CourseCoordinates[]``  — centroid lat/lng per hole for markers + distances
 *   - ``GeoJSON.Feature[]``    — full polygon features for the polygon overlay layer
 *
 * No new dependencies.  Centroid computation uses simple arithmetic mean (the
 * same approach as course_spatial.py _ring_centroid); GeoJSON types come from
 * the global @types/geojson already in the project.
 */

import { fetchAPI } from '@/lib/api';
import type { CourseData } from './types';
import type { CourseCoordinates } from '@/lib/golf-api';

export type { CourseData };

// ── Centroid helper ────────────────────────────────────────────────────────────

/**
 * Arithmetic-mean centroid of a GeoJSON Polygon outer ring.
 *
 * Mirrors backend ``_ring_centroid`` in ``course_spatial.py``: the closing
 * duplicate vertex (ring[0] === ring[-1]) is excluded from the mean so it
 * does not bias the result.
 *
 * Returns ``null`` for null/empty input (callers treat null as "no centroid").
 */
function _polygonCentroid(
  polygon: GeoJSON.Polygon | null | undefined
): { lat: number; lng: number } | null {
  const ring = polygon?.coordinates?.[0];
  if (!ring || ring.length === 0) return null;

  // Exclude the closing duplicate vertex when present.
  const isClosedRing =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const verts = isClosedRing ? ring.slice(0, -1) : ring;
  if (verts.length === 0) return null;

  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of verts) {
    sumLng += lng;
    sumLat += lat;
  }
  return { lng: sumLng / verts.length, lat: sumLat / verts.length };
}

// ── API fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch a mapped course from the backend PostGIS store.
 *
 * Route: GET /api/courses/mapped/{id}
 * Returns the full CourseData including per-hole GeoJSON features (greens,
 * fairways, tees, bunkers, water as Polygon geometry with featureType +
 * hole number in properties).
 *
 * Throws on non-2xx responses (fetchAPI behaviour).
 */
export async function fetchMappedCourse(id: string): Promise<CourseData> {
  const data = await fetchAPI<{ course: CourseData }>(
    `/api/courses/mapped/${encodeURIComponent(id)}`
  );
  return data.course;
}

// ── Coordinate conversion ─────────────────────────────────────────────────────

/**
 * Convert a mapped CourseData's GeoJSON features into CourseCoordinates[].
 *
 * GPSMapView requires a ``CourseCoordinates[]`` array with at minimum a green
 * centroid per hole.  This function extracts those centroids from the stored
 * polygon features:
 *
 * - ``green``  polygon centroid → ``green``  (required; holes without one are skipped)
 * - ``tee``    polygon centroid → ``tee``    (optional)
 * - ``bunker`` polygon centroids → ``hazards`` entries (type: "bunker")
 * - ``water``  polygon centroids → ``hazards`` entries (type: "water")
 *
 * For fairway polygons only a single centroid per hole is extracted for
 * ``hazards`` (fairways rarely need a distance measurement, but including
 * the centroid doesn't hurt).
 *
 * Returns an empty array when the course has no stored hole features (i.e.
 * the OSM ingest script has not been run yet for this course).
 */
export function mappedCourseToCoordinates(course: CourseData): CourseCoordinates[] {
  const coords: CourseCoordinates[] = [];

  for (const hole of course.holes) {
    const features = hole.features?.features ?? [];
    if (features.length === 0) continue;

    let green: { lat: number; lng: number } | undefined;
    let tee: { lat: number; lng: number } | undefined;
    // The golf=hole centerline (first point = tee, last = green center) — the most
    // reliable green/tee source, used as a fallback when polygons are absent.
    let centerline: number[][] | undefined;
    const hazards: Array<{ type: string; lat: number; lng: number }> = [];

    for (const feat of features) {
      const ft = (feat.properties?.featureType as string | undefined) ?? '';
      const geom = feat.geometry;
      if (!geom) continue;

      if (geom.type === 'Polygon') {
        const centroid = _polygonCentroid(geom as GeoJSON.Polygon);
        if (!centroid) continue;
        if (ft === 'green' && !green) green = centroid;
        else if (ft === 'tee' && !tee) tee = centroid;
        else if (ft === 'bunker' || ft === 'water') hazards.push({ type: ft, ...centroid });
      } else if (geom.type === 'LineString' && (ft === 'hole' || !centerline)) {
        // Prefer the feature explicitly typed 'hole'; else the first LineString.
        const coords = (geom as GeoJSON.LineString).coordinates;
        if (coords.length >= 2) centerline = coords;
      }
    }

    // Fall back to the hole centerline endpoints so a hole always yields a green
    // (and tee) even when its green/tee aren't tagged as polygons — the previous
    // behaviour skipped these holes, leaving the satellite map with no coords.
    if (centerline) {
      if (!tee) {
        const first = centerline[0];
        tee = { lat: first[1], lng: first[0] };
      }
      if (!green) {
        const last = centerline[centerline.length - 1];
        green = { lat: last[1], lng: last[0] };
      }
    }

    // Green is the primary distance target; skip holes with no derivable green.
    if (!green) continue;

    coords.push({
      holeNumber: hole.number,
      green,
      tee,
      hazards: hazards.length > 0 ? hazards : undefined,
    });
  }

  return coords;
}

// ── Polygon feature extraction ────────────────────────────────────────────────

/**
 * Return a flat array of ALL GeoJSON features from every hole in the course.
 *
 * Each feature already has ``properties.hole`` (hole number) and
 * ``properties.featureType`` set by the backend ``get_course`` function.
 * This array is passed to ``GPSMapView`` as the ``osmFeatures`` prop so the
 * map can render full polygon outlines for the current hole.
 *
 * A defensive guard adds ``properties.hole`` when the backend omits it
 * (should not happen with the current schema, but protects against older rows).
 */
export function getAllHoleFeatures(course: CourseData): GeoJSON.Feature[] {
  const result: GeoJSON.Feature[] = [];

  for (const hole of course.holes) {
    const features = hole.features?.features ?? [];
    for (const feat of features) {
      if (feat.properties && feat.properties.hole == null) {
        // Guard: inject the hole number if the backend didn't set it.
        result.push({
          ...feat,
          properties: { ...feat.properties, hole: hole.number },
        } as GeoJSON.Feature);
      } else {
        result.push(feat as GeoJSON.Feature);
      }
    }
  }

  return result;
}
