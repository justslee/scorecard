/**
 * Pure config/decision logic for CourseScoutMap's search-highlight marker,
 * initial-bounds prime, and POI-suppression styling (B2 map mode). Zero
 * DOM/plugin/React imports, mirroring scout-viewport.ts, so this is
 * unit-testable in Node without dragging in framer-motion or the
 * @capacitor/google-maps plugin bridge. See
 * specs/map-markers-course-location-plan.md.
 */

import type { BBox } from "@/lib/golf-api";

/** Source geometry of the committed pin SVG (scripts/render-course-flag.mjs):
 *  viewBox 0 0 32 40; the visual tip is at (16, 38) — NOT the viewBox
 *  bottom (2 units of baked shadow room). Anchoring at {w/2, h} would
 *  float the pin 5% above the course coordinate. */
export const PIN_VIEWBOX = { width: 32, height: 40 };
export const PIN_TIP = { x: 16, y: 38 };

/** Displayed size + tip anchor for a pin of the given height (pt).
 *  Multiply-then-divide keeps the committed heights (27.5, 45) exact. */
export function pinIconGeometry(height: number): {
  iconSize: { width: number; height: number };
  iconAnchor: { x: number; y: number };
} {
  const width = (height * PIN_VIEWBOX.width) / PIN_VIEWBOX.height;
  return {
    iconSize: { width, height },
    iconAnchor: {
      x: (PIN_TIP.x * width) / PIN_VIEWBOX.width,
      y: (PIN_TIP.y * height) / PIN_VIEWBOX.height,
    },
  };
}

/** Quiet in-bounds pin icon (shared by CourseScoutMap.pinToMarker). */
export const QUIET_PIN_ICON = {
  iconUrl: "assets/course-flag.png",
  ...pinIconGeometry(27.5), // -> 22×27.5, anchor {11, 26.125}
};

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
}

/**
 * Build the highlight marker for the searched (panTarget) course.
 * course-flag-highlight.png (T.flag pennant), 45pt tall with the tip-locked
 * anchor from pinIconGeometry, sitting above the quiet pin layer via zIndex.
 * `target.name` is no longer read here — the name reaches the tap-card
 * through the synthesized InBoundsCourse in markerIndexRef (CourseScoutMap).
 *
 * Pure function — no side effects, headless-testable.
 */
export function highlightMarkerFor(target: {
  name: string;
  center: { lat: number; lng: number };
}): HighlightMarker {
  return {
    coordinate: target.center,
    iconUrl: "assets/course-flag-highlight.png",
    ...pinIconGeometry(45), // -> 36×45, anchor {18, 42.75}
    zIndex: 2,
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
export const SCOUT_POI_SUPPRESSION: google.maps.MapTypeStyle[] = [
  // All POI icons + names (museums, restaurants, hospitals, stores) — off.
  // labels only: park/golf GREEN GEOMETRY stays (a golf map needs its fairways).
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  // Businesses entirely (belt over the labels rule).
  { featureType: "poi.business", stylers: [{ visibility: "off" }] },
  // Transit stations/lines clutter.
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

/**
 * Base-map paper/ink retone for the B2 scout map (MapType.Normal) — maps the
 * yardage-book T.* palette (components/yardage/tokens.ts) onto Google's
 * landscape/road/water/label layers so the map reads as printed paper, not
 * stock Google. Values are inlined hex (GMSMapStyle can't parse rgba/oklch);
 * each rule's comment names the token it derives from. Order matters:
 * general featureTypes precede specific ones (later/specific rules win).
 * See specs/map-paper-tone-plan.md.
 */
export const SCOUT_MAP_BASE_TONE: google.maps.MapTypeStyle[] = [
  // ── Landscape → paper ─────────────────────────────────────────────
  // T.paper
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#f4f1ea" }] },
  // T.paperDeep — natural terrain a shade deeper, keeps subtle texture
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#ece7db" }] },
  // paper↔paperDeep blend — urban blocks/building ground
  { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#f0ece2" }] },

  // ── POI ground → paper; park/golf greenery → on-paper sage ────────
  // T.paperDeep — institutional footprints (schools/hospitals) melt into paper
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#ece7db" }] },
  // T.paper shifted toward T.inkSoft's green hue, deepened for a faster fairway read —
  // parks/fairways stay VISIBLY green (a golf map needs them) but calm
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#d3ddc4" }] },

  // ── Water → muted blue-gray, NOT stock Google blue ────────────────
  // T.accent's blue family desaturated ~85% and lifted to paper luminance
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#c9d4d6" }] },
  // T.pencil on T.paper — water names in pencil, paper halo
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#6b6558" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#f4f1ea" }] },

  // ── Roads → pale fills + pencil strokes; hierarchy = darkness ladder
  //    (highway darkest → local lightest; never one flat weight) ──────
  // mid(T.paperDeep, T.paperEdge), darkened — highways most present, distinct from arterial
  { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#dbd4c3" }] },
  // T.paperEdge pulled 1/3 toward T.pencilSoft — a drawn edge, not neon
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#c2bbaa" }] },
  // mid(T.paper, T.paperDeep), pulled down — separated from local fill
  { featureType: "road.arterial", elementType: "geometry.fill", stylers: [{ color: "#e9e3d5" }] },
  // T.paperEdge
  { featureType: "road.arterial", elementType: "geometry.stroke", stylers: [{ color: "#d9d2c0" }] },
  // T.paper lifted slightly toward white — locals quietest, just above paper
  { featureType: "road.local", elementType: "geometry.fill", stylers: [{ color: "#f8f7f2" }] },
  // T.hairline flattened onto T.paper, lightened — clearly distinct from arterial stroke
  { featureType: "road.local", elementType: "geometry.stroke", stylers: [{ color: "#e6e3da" }] },

  // ── Road labels → pencil on paper; colorful route shields off ─────
  // T.pencil
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#6b6558" }] },
  // T.paper halo keeps text legible over any fill
  { featureType: "road", elementType: "labels.text.stroke", stylers: [{ color: "#f4f1ea" }] },
  // T.inkSoft — highway names read a step stronger (hierarchy in labels too)
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#3a4a38" }] },
  // Route shields (US-101 reds/blues) can't be recolored, only hidden —
  // the one loud element paper can't absorb. Icons only; road text stays.
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },

  // ── Administrative → ink/pencil ───────────────────────────────────
  // T.paperEdge — boundaries as faint drawn lines
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#d9d2c0" }] },
  // T.inkSoft on T.paper
  { featureType: "administrative", elementType: "labels.text.fill", stylers: [{ color: "#3a4a38" }] },
  { featureType: "administrative", elementType: "labels.text.stroke", stylers: [{ color: "#f4f1ea" }] },
  // T.ink — city names are the strongest text on the page
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#1a2a1a" }] },
  // T.pencil — neighborhood names recede but clear AA on paper (~5.13:1)
  { featureType: "administrative.neighborhood", elementType: "labels.text.fill", stylers: [{ color: "#6b6558" }] },
];

/**
 * The full B2 scout-map style: paper/ink base tone + the shipped POI/transit
 * suppression. Base tone first, suppression last — suppression's
 * visibility:"off" wins regardless, but keep the quieting rules terminal for
 * readability. CourseScoutMap imports this name unchanged.
 */
export const SCOUT_MAP_STYLES: google.maps.MapTypeStyle[] = [
  ...SCOUT_MAP_BASE_TONE,
  ...SCOUT_POI_SUPPRESSION,
];
