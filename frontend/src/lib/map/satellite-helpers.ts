/**
 * Satellite-map pure helpers — extracted for headless unit testing.
 *
 * None of these functions import mapbox-gl, DOM APIs, or React.  They can run
 * in Node (vitest) without a browser or any mocking.
 *
 * The visual logic that can't be unit-tested (Mapbox tile rendering, marker
 * DOM creation) lives in GPSMapView.tsx.  These helpers cover the coordinate
 * math and renderer-selection logic that CAN be tested deterministically.
 */

import type { CourseCoordinates } from '@/lib/golf-api';

// ── Renderer selection ────────────────────────────────────────────────────────

export type MapRenderer = 'mapbox' | 'holediagram';

/**
 * Decide which hole-map renderer to use based on the Mapbox public token.
 *
 * 'mapbox'      — token is a non-empty, non-whitespace string
 * 'holediagram' — token is absent, empty, or whitespace-only
 *
 * Pure function — safe in SSR / server components (no window/DOM access).
 */
export function mapRendererFor(token: string | undefined | null): MapRenderer {
  return token && token.trim().length > 0 ? 'mapbox' : 'holediagram';
}

// ── Hole bounds ───────────────────────────────────────────────────────────────

/**
 * Compute a geographic bounding box for a hole, suitable for Mapbox fitBounds.
 *
 * Returns `[[lngSW, latSW], [lngNE, latNE]]` — the south-west and north-east
 * corners enclosing the tee, the green, and (optionally) the user's position.
 *
 * Pure function — no mapbox-gl import, no DOM.
 */
export function holeViewBounds(
  holeCoords: Pick<CourseCoordinates, 'tee' | 'green'>,
  userPos?: { lat: number; lng: number } | null
): [[number, number], [number, number]] {
  const pts: Array<{ lat: number; lng: number }> = [holeCoords.green];
  if (holeCoords.tee) pts.push(holeCoords.tee);
  if (userPos) pts.push(userPos);

  let minLat = pts[0].lat;
  let maxLat = pts[0].lat;
  let minLng = pts[0].lng;
  let maxLng = pts[0].lng;

  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

// ── Label formatters ──────────────────────────────────────────────────────────

/**
 * Format a tap-to-measure distance label.
 *
 * Returns e.g. "Tee 215y · Pin 185y" when tee distance is known, or
 * "Pin 185y" when it isn't (tee coords absent from this hole's data).
 *
 * Pure function.
 */
export function tapMeasureLabel(
  fromTeeYards: number | null,
  toPinYards: number
): string {
  if (fromTeeYards !== null) {
    return `Tee ${fromTeeYards}y · Pin ${toPinYards}y`;
  }
  return `Pin ${toPinYards}y`;
}

/**
 * Format a Front / Center / Back green distance label.
 *
 * Returns e.g. "F 148 · C 163 · B 178"
 *
 * Pure function.
 */
export function formatFCBLabel(
  front: number,
  center: number,
  back: number
): string {
  return `F ${front} · C ${center} · B ${back}`;
}

// ── OSM-feature annotation ────────────────────────────────────────────────────

/**
 * Annotate a flat list of GeoJSON features with `properties.hole = holeNumber`
 * so GPSMapView's `updateOsmPolygons` can filter them by current hole.
 *
 * Input: an array of `(holeNumber, features[])` pairs (one per hole).
 * Output: a single flat feature array with the `hole` property injected.
 *
 * Pure function — safe to call in useMemo.
 */
export function annotateOsmFeatures(
  holeFeaturePairs: Array<{ holeNumber: number; features: GeoJSON.Feature[] }>
): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  for (const { holeNumber, features } of holeFeaturePairs) {
    for (const f of features) {
      out.push({
        ...f,
        properties: { ...(f.properties ?? {}), hole: holeNumber },
      });
    }
  }
  return out;
}
