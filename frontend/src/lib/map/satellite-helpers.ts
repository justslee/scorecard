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

// ── Map base style ────────────────────────────────────────────────────────────

/**
 * The two base rendering modes for the GPS map view.
 *
 * 'vector'    — clean yardage-book style: paper background + OSM shape fills
 *               (uses mapbox://styles/mapbox/empty-v9 as the Mapbox base so
 *               there are no street labels, roads, or satellite imagery).
 * 'satellite' — aerial imagery (mapbox://styles/mapbox/satellite-v9) shown as
 *               a raster layer beneath the OSM fill/outline overlays.
 */
export type MapBaseStyle = 'vector' | 'satellite';

/**
 * Mapbox style URL for each base rendering mode.
 *
 * Pure function — safe in SSR / server components.
 */
export function baseStyleUrl(_mode: MapBaseStyle): string {
  // Both modes share the same Mapbox base style (empty-v9) because we toggle
  // the satellite raster layer on/off as a custom layer rather than calling
  // map.setStyle() — this avoids re-initialising all custom sources/layers.
  // Keeping 'empty-v9' means the canvas starts blank, and we paint everything:
  //   vector mode:    paper-background layer  + OSM fills  (full opacity)
  //   satellite mode: satellite-raster layer  + OSM fills  (reduced opacity)
  return 'mapbox://styles/mapbox/empty-v9';
}

// ── OSM layer paint helpers ────────────────────────────────────────────────────

/** Return the hex fill colour for an OSM feature type in a given rendering mode. */
export function osmFillColor(featureType: string, mode: MapBaseStyle): string {
  if (mode === 'vector') {
    const MAP: Record<string, string> = {
      green:   '#8cb264',   // PAL.green solid (rgba 140,178,100)
      fairway: '#a8c67e',   // PAL.fairway solid (rgba 168,198,126)
      bunker:  '#dec896',   // PAL.bunker solid (rgba 222,200,150)
      tee:     '#a8c67e',   // same as fairway
      water:   '#6894b4',   // PAL.water solid (rgba 104,148,180)
      rough:   '#bec38c',   // PAL.roughFill solid (rgba 190,195,140)
    };
    return MAP[featureType] ?? '#ddd8c6'; // PAL.ground
  } else {
    const MAP: Record<string, string> = {
      green:   '#22c55e',
      fairway: '#86efac',
      bunker:  '#fbbf24',
      tee:     '#c084fc',
      water:   '#60a5fa',
    };
    return MAP[featureType] ?? '#9ca3af';
  }
}

/** Return the fill opacity for an OSM feature type in a given rendering mode. */
export function osmFillOpacity(featureType: string, mode: MapBaseStyle): number {
  if (mode === 'vector') {
    const MAP: Record<string, number> = {
      green:   0.90,
      fairway: 0.82,
      bunker:  0.90,
      tee:     0.80,
      water:   0.68,
      rough:   0.78,
    };
    return MAP[featureType] ?? 1.0;
  } else {
    const MAP: Record<string, number> = {
      green:   0.40,
      fairway: 0.18,
      bunker:  0.50,
      tee:     0.30,
      water:   0.40,
    };
    return MAP[featureType] ?? 0.25;
  }
}

/** Return the outline (line) colour for an OSM feature type in a given rendering mode. */
export function osmOutlineColor(featureType: string, mode: MapBaseStyle): string {
  if (mode === 'vector') {
    const MAP: Record<string, string> = {
      green:   '#3a4a38',   // T.inkSoft (PAL.greenEdge)
      fairway: '#789b50',   // PAL.fairwayEdge solid
      bunker:  '#af965f',   // PAL.bunkerEdge solid
      tee:     '#789b50',
      water:   '#4670a4',   // PAL.waterEdge solid
      rough:   '#8c945a',   // PAL.roughEdge solid
    };
    return MAP[featureType] ?? '#6b6558';
  } else {
    const MAP: Record<string, string> = {
      green:   '#16a34a',
      fairway: '#22c55e',
      bunker:  '#d97706',
      tee:     '#9333ea',
      water:   '#3b82f6',
    };
    return MAP[featureType] ?? '#6b7280';
  }
}

// ── Course display mode ───────────────────────────────────────────────────────

/**
 * Which rendering path the /map/course page should take.
 *
 * 'ingested'    — course has full hole-by-hole geometry in our DB.
 * 'center-only' — no ingested data, but lat/lng are available; satellite +
 *                 GPS + tap-to-measure work; no hole overlays or nav.
 * 'no-data'     — neither id nor lat/lng — show the error/no-course-found screen.
 */
export type CourseDisplayMode = 'ingested' | 'center-only' | 'no-data';

/**
 * Determine which map display mode to use.
 * Pure function — safe to call anywhere (SSR, tests, useMemo).
 */
export function courseDisplayMode(opts: {
  hasIngestedCourse: boolean;
  hasCenterParams: boolean;
}): CourseDisplayMode {
  if (opts.hasIngestedCourse) return 'ingested';
  if (opts.hasCenterParams) return 'center-only';
  return 'no-data';
}

// ── Center params parsing ─────────────────────────────────────────────────────

/** Parsed lat/lng/name from a URL query string. */
export interface CenterParams {
  lat: number;
  lng: number;
  name: string;
}

/**
 * Parse lat, lng, and name search params for center-only map mode.
 *
 * Returns `null` when `lat` or `lng` are missing or not valid finite coordinates.
 * `name` defaults to `''` when absent.
 *
 * The `get` parameter is decoupled from URLSearchParams so this function can be
 * called in unit tests without a DOM or Next.js router.
 */
export function parseCenterParams(
  get: (key: string) => string | null
): CenterParams | null {
  const latStr = get('lat');
  const lngStr = get('lng');
  if (!latStr || !lngStr) return null;

  const lat = Number(latStr);
  const lng = Number(lngStr);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng, name: get('name') ?? '' };
}

// ── Renderer selection ────────────────────────────────────────────────────────

/**
 * Which hole-map renderer to use.
 *
 * 'google'      — Google Maps satellite imagery via @capacitor/google-maps.
 *                 Active when NEXT_PUBLIC_GOOGLE_MAPS_KEY is set.
 * 'holediagram' — on-paper SVG fallback (no key / development / offline).
 *
 * NOTE: Mapbox was the previous renderer; it has been retired in favour of
 * Google Maps satellite.  CaddiePanel.tsx still uses mapbox-gl directly
 * (a separate sub-feature) — the mapbox-gl package is kept for that use.
 */
export type MapRenderer = 'google' | 'holediagram';

/**
 * Decide which hole-map renderer to use based on the Google Maps public key.
 *
 * 'google'      — key is a non-empty, non-whitespace string
 * 'holediagram' — key is absent, empty, or whitespace-only
 *
 * Pure function — safe in SSR / server components (no window/DOM access).
 */
export function mapRendererFor(key: string | undefined | null): MapRenderer {
  return key && key.trim().length > 0 ? 'google' : 'holediagram';
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

// ── On-hole GPS guard ─────────────────────────────────────────────────────────

/**
 * Compute the geographic bounding box of a hole from its known coordinate points.
 *
 * Includes tee, green, front of green, and back of green when available.
 * The resulting bbox is used by `isGpsOnHole` to decide whether a GPS position
 * is near the hole or far away (e.g. at home 28 miles away).
 *
 * Pure function — no side effects, headless-testable.
 */
export function holeCoordsBbox(
  holeCoords: Pick<CourseCoordinates, 'tee' | 'green' | 'front' | 'back'>
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const pts: Array<{ lat: number; lng: number }> = [holeCoords.green];
  if (holeCoords.tee)   pts.push(holeCoords.tee);
  if (holeCoords.front) pts.push(holeCoords.front);
  if (holeCoords.back)  pts.push(holeCoords.back);

  let minLat = pts[0].lat, maxLat = pts[0].lat;
  let minLng = pts[0].lng, maxLng = pts[0].lng;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Returns true when a GPS position is within (or near) the hole's bounding box.
 *
 * The default margin of 0.006° ≈ 660 m covers any player anywhere on the hole
 * (tee box, fairway, green approach) while correctly rejecting a position that
 * is many miles away (e.g. at home — the root cause of the "49 000 yd" bug).
 *
 * When this returns false:
 *   • Do NOT draw the GPS "you" dot or the GPS→pin distance line.
 *   • Do NOT use GPS as the origin for F/C/B distance rings.
 *   • Show tee-based distances in the info strip instead.
 *   • Frame the map on the hole tee→green corridor only (never on a far GPS fix).
 *
 * Pure function — no side effects, headless-testable.
 */
export function isGpsOnHole(
  pos: { lat: number; lng: number },
  holeCoords: Pick<CourseCoordinates, 'tee' | 'green' | 'front' | 'back'>,
  marginDeg = 0.006
): boolean {
  const { minLat, maxLat, minLng, maxLng } = holeCoordsBbox(holeCoords);
  return (
    pos.lat >= minLat - marginDeg &&
    pos.lat <= maxLat + marginDeg &&
    pos.lng >= minLng - marginDeg &&
    pos.lng <= maxLng + marginDeg
  );
}

// ── Map view preference (localStorage) ───────────────────────────────────────

/** localStorage key for the user's map view preference. */
export const MAP_VIEW_PREF_KEY = 'looper_map_view_pref';

/**
 * User's preferred map view — persisted across sessions.
 *
 * 'holediagram' — on-paper SVG (safe default; no Google Maps init on load)
 * 'satellite'   — Google satellite imagery (user has explicitly opted in)
 */
export type MapViewPref = 'holediagram' | 'satellite';

/**
 * Read the user's map view preference from localStorage.
 *
 * Returns 'holediagram' (the safe default) when:
 *   • no preference has been stored yet (fresh user / after a crash)
 *   • localStorage is unavailable (SSR / sandboxed env)
 *   • the stored value is not a recognised preference
 *
 * SSR-safe: checks `typeof window` before touching localStorage.
 */
export function getMapViewPref(): MapViewPref {
  try {
    if (typeof window === 'undefined') return 'holediagram';
    const v = localStorage.getItem(MAP_VIEW_PREF_KEY);
    if (v === 'satellite') return 'satellite';
  } catch {
    // localStorage unavailable (sandboxed iframe, private browsing, etc.)
  }
  return 'holediagram';
}

/**
 * Persist the user's map view preference.
 *
 * No-ops silently when localStorage is unavailable.
 */
export function setMapViewPref(pref: MapViewPref): void {
  try {
    if (typeof window === 'undefined') return;
    localStorage.setItem(MAP_VIEW_PREF_KEY, pref);
  } catch {
    // localStorage unavailable — preference is ephemeral this session.
  }
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
