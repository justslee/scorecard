/**
 * Pure config/decision logic for CourseScoutMap's search-highlight marker,
 * initial-bounds prime, and POI-suppression styling (B2 map mode). Zero
 * DOM/plugin/React imports, mirroring scout-viewport.ts, so this is
 * unit-testable in Node without dragging in framer-motion or the
 * @capacitor/google-maps plugin bridge. See
 * specs/map-markers-course-location-plan.md.
 */

import type { BBox } from "@/lib/golf-api";

/** Decision table for the search-highlight marker's remove/add/replace lifecycle. */
export type HighlightAction = "none" | "remove" | "add" | "replace";

/**
 * Decide what to do with the single live highlight marker given the current
 * highlighted course id (or null if none) and the new panTarget's course id
 * (or null if the search was cleared).
 *
 * Pure function — no side effects, headless-testable.
 */
export function deriveHighlightAction(
  currentCourseId: string | null,
  targetCourseId: string | null,
): HighlightAction {
  if (currentCourseId === null && targetCourseId === null) return "none";
  if (currentCourseId !== null && targetCourseId === null) return "remove";
  if (currentCourseId === null && targetCourseId !== null) return "add";
  if (currentCourseId === targetCourseId) return "none";
  return "replace";
}

/** Plain-data marker shape for the search-highlight flag (mirrors the
 *  plugin's Marker type without importing it — kept pure/DOM-free). */
export interface HighlightMarker {
  coordinate: { lat: number; lng: number };
  iconUrl: string;
  iconSize: { width: number; height: number };
  iconAnchor: { x: number; y: number };
  zIndex: number;
  title: string;
}

/**
 * Build the highlight marker for the searched (panTarget) course. Reuses
 * course-flag.png (no new binary asset) at 1.5x the quiet in-bounds pin's
 * size (26px → 40px) with a proportionally scaled anchor, sitting above the
 * quiet pin layer via zIndex.
 *
 * Pure function — no side effects, headless-testable.
 */
export function highlightMarkerFor(target: {
  name: string;
  center: { lat: number; lng: number };
}): HighlightMarker {
  return {
    coordinate: target.center,
    iconUrl: "assets/course-flag.png",
    iconSize: { width: 40, height: 40 },
    iconAnchor: { x: 8, y: 40 },
    zIndex: 2,
    title: target.name,
  };
}

/**
 * Convert the native plugin's camera-idle bounds shape into the BBox shape
 * `ScoutCoordinator.onCameraIdle` expects. Used both by the real camera-idle
 * listener and the one-shot initial-bounds prime (§3 of the plan).
 *
 * Pure function — no side effects, headless-testable.
 */
export function boundsToBBox(b: {
  southwest: { lat: number; lng: number };
  northeast: { lat: number; lng: number };
}): BBox {
  return {
    swLat: b.southwest.lat,
    swLng: b.southwest.lng,
    neLat: b.northeast.lat,
    neLng: b.northeast.lng,
  };
}

/**
 * Google Maps style rules for the B2 scout map — suppresses POI icon/label
 * clutter (museums, restaurants, IKEA, transit) while leaving roads, water,
 * administrative labels, and park/golf-course green geometry untouched.
 * `featureType: "poi"` is scoped to `elementType: "labels"` (not the whole
 * feature) so course/park green fills survive.
 *
 * The `google.maps.MapTypeStyle` type resolves ambiently via the
 * @capacitor/google-maps plugin's `@types/google.maps` dependency — no
 * import needed (and none of these values touch the DOM or the plugin at
 * runtime; this is a plain data array).
 */
export const SCOUT_MAP_STYLES: google.maps.MapTypeStyle[] = [
  // All POI icons + names (museums, restaurants, hospitals, stores) — off.
  // labels only: park/golf GREEN GEOMETRY stays (a golf map needs its fairways).
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  // Businesses entirely (belt over the labels rule).
  { featureType: "poi.business", stylers: [{ visibility: "off" }] },
  // Transit stations/lines clutter.
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];
