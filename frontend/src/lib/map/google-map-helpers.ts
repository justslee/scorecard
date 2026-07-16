/**
 * Pure helpers for the Google satellite map overlay.
 *
 * None of these functions import DOM APIs, the @capacitor/google-maps plugin,
 * or React.  They can run in Node (vitest) without a browser or mocking.
 *
 * The visual logic that can't be unit-tested (native map creation, marker DOM,
 * platform bridge calls) lives in GoogleSatelliteMap.tsx.  These helpers cover
 * the coordinate math and renderer-selection logic that CAN be tested
 * deterministically.
 */

import type { CourseCoordinates } from '@/lib/golf-api';
import { holeViewBounds } from './satellite-helpers';

// ── Unit conversion ───────────────────────────────────────────────────────────

/** Exact conversion factor: metres per yard (international yard, 1959). */
export const METRES_PER_YARD = 0.9144;

/**
 * Convert a distance in yards to metres.
 *
 * Google Maps circle radii and polyline distances are expressed in metres.
 * Pure function — no side effects.
 */
export function yardsToMeters(yards: number): number {
  return yards * METRES_PER_YARD;
}

// ── Layup ring configuration ──────────────────────────────────────────────────

/** Fixed layup ring yardages from the green centre (100 / 150 / 200). */
export const LAYUP_RING_YARDS = [100, 150, 200] as const;

/**
 * Stroke colour for each layup ring yardage.
 * Warm palette: near rings are amber, far rings are red — visually intuitive.
 */
export const LAYUP_RING_COLORS: Record<(typeof LAYUP_RING_YARDS)[number], string> = {
  100: '#fcd34d', // amber-300 — nearest layup
  150: '#fb923c', // orange-400 — mid layup
  200: '#ef4444', // red-500   — farthest layup
};

// ── F/C/B ring colours ────────────────────────────────────────────────────────

/**
 * Stroke colours for the approach distance (Front / Center / Back) circles.
 * Matches the colours used in GPSMapView.tsx so the two renderers look consistent.
 */
export const FCB_RING_COLORS: Record<'front' | 'center' | 'back', string> = {
  front:  '#fcd34d', // amber-300
  center: '#6ee7b7', // emerald-300
  back:   '#fb923c', // orange-400
};

// ── Camera framing ────────────────────────────────────────────────────────────

/**
 * Compute the SW / NE corners and geographic centre of a hole's bounding box.
 *
 * Kept for compatibility with existing tests and the `holeMapBounds` export.
 * NOTE: Do NOT pass the result to `GoogleMap.fitBounds()` — that method crashes
 * on iOS with a native NSException when the GMSMapView is nil (v9.4.0 race).
 * Use `cameraForHole()` + `map.setCamera()` instead.
 *
 * Deliberately excludes the GPS position so a far-away GPS fix (e.g. at home)
 * cannot force the map to zoom out to frame a 28-mile span — preserving the
 * v1.0.598 off-hole fix.
 *
 * Pure function — no side effects, headless-testable.
 */
export function holeMapBounds(
  holeCoords: Pick<CourseCoordinates, 'tee' | 'green'>,
): {
  southwest: { lat: number; lng: number };
  northeast: { lat: number; lng: number };
  center:    { lat: number; lng: number };
} {
  const [[swLng, swLat], [neLng, neLat]] = holeViewBounds(holeCoords);
  return {
    southwest: { lat: swLat, lng: swLng },
    northeast: { lat: neLat, lng: neLng },
    center:    { lat: (swLat + neLat) / 2, lng: (swLng + neLng) / 2 },
  };
}

/** Default zoom level for center-only mode (non-ingested course, no hole data). */
export const CENTER_ONLY_ZOOM = 17;

// ── fitBounds-free camera framing ─────────────────────────────────────────────
//
// The plugin's map.fitBounds() crashes on iOS with a native NSException when
// the GMSMapView is still nil (race condition in @capacitor/google-maps v9.4.0):
//   Swift runtime failure: Unexpectedly found nil while implicitly unwrapping an Optional
//     Map.fitBounds(bounds:padding:)            Map.swift:566
//     CapacitorGoogleMapsPlugin.fitBounds(_:)  CapacitorGoogleMapsPlugin.swift:942
//
// The fix: compute center + zoom ourselves and use map.setCamera() instead.
// JS cannot catch native NSExceptions, so replacing the call is the only fix.

/**
 * Approximate straight-line distance in yards between two lat/lng points.
 *
 * Uses the Haversine formula — accurate to ~0.1% within the scale of a golf
 * hole (< 1 km).  Inlined here to keep google-map-helpers.ts dependency-free
 * (avoids importing the GPS watcher from @/lib/gps).
 *
 * Pure function — no side effects, headless-testable.
 */
export function haversineYards(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R_KM = 6371; // Earth mean radius in km
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dlat = toRad(b.lat - a.lat);
  const dlng = toRad(b.lng - a.lng);

  const sinDlat = Math.sin(dlat / 2);
  const sinDlng = Math.sin(dlng / 2);
  const h = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlng * sinDlng;
  const km = 2 * R_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return Math.round((km * 1000) / METRES_PER_YARD);
}

/**
 * Should the GPS camera re-anchor to a new position? True when there is no prior
 * anchor (first fix on the hole) or the player has moved more than `thresholdYards`
 * since the last anchor — so the map follows the golfer without jittering on every
 * sub-threshold GPS tick.
 */
export function movedBeyondYards(
  from: { lat: number; lng: number } | null | undefined,
  to: { lat: number; lng: number },
  thresholdYards: number,
): boolean {
  if (!from) return true;
  return haversineYards(from, to) > thresholdYards;
}

/**
 * Return a Google Maps integer zoom level for a padded hole length in yards.
 *
 * Table tuned for a ~390×844 px iPhone 14 viewport so the whole hole fits
 * within the screen at each zoom level.  Padded yards = tee→green straight
 * distance × 1.35 (35% buffer for fairway width on either side).
 *
 * Clamp range [14, 18]:
 *   18 — short par-3 (<150 yd padded)
 *   17 — mid par-3 / short par-4 (150–275 yd)
 *   16 — typical par-4 (275–450 yd)
 *   15 — long par-4 / short par-5 (450–700 yd)
 *   14 — long par-5 / >700 yd
 *
 * Pure function — no side effects, headless-testable.
 */
export function zoomForPaddedYards(paddedYards: number): number {
  // Tuned to frame a SINGLE hole tightly (owner: "more zoomed in to just that
  // hole"). Fractional zooms are supported by the Google Maps SDK.
  // Rotated (down-the-fairway) view needs the whole tee→green to fit vertically
  // AND the tee box to clear the bottom panel, so it's ~1 level back from a pure
  // fill. Still tight to the single hole (no surrounding-hole clutter).
  if (paddedYards < 130) return 18;
  if (paddedYards < 220) return 17.5;
  if (paddedYards < 480) return 17;
  if (paddedYards < 650) return 16.5;
  return 16;
}

/**
 * Initial bearing in degrees clockwise from true north, from `a` to `b`.
 * Used to rotate the map so a line (tee→green, or player→green) points UP the
 * screen — the yardage-book "looking down the fairway" orientation.
 */
export function bearingDegrees(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export interface HoleCamera {
  coordinate: { lat: number; lng: number };
  zoom: number;
  /** Degrees clockwise from north; rotates the map to look from→to (up-screen). */
  bearing: number;
}

/**
 * Frame the camera to look from `from` down to `to` (the green), oriented so
 * the from→to line runs UP the screen — a golfer looking down the fairway.
 *   • center  = midpoint(from, to) → `from` sits near the bottom, green near top
 *   • zoom    = fit the from→to distance (small pad)
 *   • bearing = from→to heading so the map rotates to look down the line
 *
 * Pure function — no side effects, headless-testable. Used for both the tee view
 * (from = tee) and the GPS view (from = the player's position).
 */
export function cameraFraming(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): HoleCamera {
  const coordinate = {
    lat: (from.lat + to.lat) / 2,
    lng: (from.lng + to.lng) / 2,
  };
  const zoom = zoomForPaddedYards(haversineYards(from, to) * 1.15);
  const bearing = bearingDegrees(from, to);
  return { coordinate, zoom, bearing };
}

/**
 * Camera to frame a whole hole from the tee box, looking down the fairway.
 * Crash-safe fitBounds replacement — pass to `setCamera` or the create config
 * (map `heading` = `bearing`). Falls back to the green when there is no tee.
 */
export function cameraForHole(
  holeCoords: Pick<CourseCoordinates, 'tee' | 'green'>,
): HoleCamera {
  const tee = holeCoords.tee ?? holeCoords.green; // fall back to green if no tee
  return cameraFraming(tee, holeCoords.green);
}

// ── Course centre resolution ──────────────────────────────────────────────────

/**
 * Resolve the map centre point to use when loading a course.
 *
 * Priority:
 *   1. Tee coordinate of the current hole (most accurate starting position).
 *   2. Green coordinate of the current hole (if no tee data).
 *   3. First-hole tee / green from the full list (fallback for center-only mode).
 *   4. Explicit `fallbackCenter` lat/lng from URL params.
 *
 * Returns null only when all sources are absent (should not occur in normal use).
 *
 * Pure function — no side effects, headless-testable.
 */
export function resolveCourseCenter(
  holeCoordinates: Pick<CourseCoordinates, 'tee' | 'green'>[],
  fallbackCenter?: { lat: number; lng: number } | null,
): { lat: number; lng: number } | null {
  if (holeCoordinates.length > 0) {
    const first = holeCoordinates[0];
    if (first.tee) return { lat: first.tee.lat, lng: first.tee.lng };
    return { lat: first.green.lat, lng: first.green.lng };
  }
  return fallbackCenter ?? null;
}

// ── Renderer selection ────────────────────────────────────────────────────────

/**
 * Decide which hole-map renderer to use based on the Google Maps public key.
 *
 * 'google'      — key is a non-empty, non-whitespace string
 * 'holediagram' — key is absent, empty, or whitespace-only (on-paper fallback)
 *
 * Pure function — safe in SSR / server components (no window/DOM access).
 */
export function googleMapRendererFor(
  key: string | undefined | null,
): 'google' | 'holediagram' {
  return key && key.trim().length > 0 ? 'google' : 'holediagram';
}

// ── Overlay label formatters ──────────────────────────────────────────────────

/**
 * Build the tap-to-measure label shown as a marker title on click.
 *
 * Returns e.g. "Tee 215y · Pin 185y" when tee distance is known, or
 * "Pin 185y" when it isn't (tee coords absent for this hole).
 *
 * Pure function.
 */
export function tapMeasureLabelGoogle(
  fromTeeYards: number | null,
  toPinYards: number,
): string {
  if (fromTeeYards !== null) return `Tee ${fromTeeYards}y · Pin ${toPinYards}y`;
  return `Pin ${toPinYards}y`;
}

export interface TapTarget {
  /** Yards from the origin (the player when on-hole, else the tee) to the tapped
   *  point — the shot's carry. Null when there's no origin. */
  carry: number | null;
  /** Yards from the tapped point to the green — what's left after the shot. */
  toGreen: number;
  /** True when `carry` was measured from the live GPS position, not the tee. */
  fromGps: boolean;
}

/**
 * Distances for a tapped target point: carry from the origin (GPS position when
 * on the hole, otherwise the tee) and the remaining distance to the green.
 * `distanceYards` is injected so callers reuse the SAME distance function as the
 * rest of the map (turf-based) — keeps this pure + headless-testable.
 */
export function tapTargetDistances(
  tap: { lat: number; lng: number },
  green: { lat: number; lng: number },
  origin: { lat: number; lng: number } | null,
  fromGps: boolean,
  distanceYards: (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number,
): TapTarget {
  return {
    carry: origin ? Math.round(distanceYards(origin, tap)) : null,
    toGreen: Math.round(distanceYards(tap, green)),
    fromGps: fromGps && origin != null,
  };
}

/**
 * Build a snippet label for a Front / Center / Back distance marker.
 *
 * Returns e.g. "F 148y" / "C 163y" / "B 178y".
 *
 * Pure function.
 */
export function fcbMarkerSnippet(
  type: 'front' | 'center' | 'back',
  yards: number,
): string {
  const prefix = type === 'front' ? 'F' : type === 'center' ? 'C' : 'B';
  return `${prefix} ${yards}y`;
}

// ── Camera queue — coalescing serializer for rapid hole changes ───────────────

export interface CameraQueue<T> {
  /**
   * Request a camera move to `target`. If no run is in flight, starts one
   * immediately. If a run IS in flight, overwrites any prior pending target
   * (last write wins) — a rapid multi-hole swipe settles on a single trailing
   * camera move for the final hole, never a pile-up of stale in-between moves.
   * Priority-aware when `shouldReplace` is supplied (see `createCameraQueue`):
   * an incoming request that `shouldReplace` rejects is dropped instead of
   * evicting the current pending target.
   */
  request(target: T): void;
}

/**
 * Coalescing serializer for native camera moves.
 *
 * The [currentHoleData] effect in GoogleSatelliteMap runs clearHoleOverlays →
 * fitCameraToHole → addHoleOverlays as an un-serialized async sequence. Rapid
 * swipes (1→2→3→4 in under a second) would otherwise race: several of those
 * async chains are in flight at once and whichever native call resolves LAST
 * wins the camera, which is not necessarily hole 4. This collapses any
 * requests that arrive while a run is in flight into ONE trailing call with
 * the most recent target once the current run finishes — so 1→2→3→4 settles
 * with a single camera move, on 4.
 *
 * `run` is injected (not the plugin) so this stays pure and DOM/plugin-free —
 * fully unit-testable without a native map. Callers keep their own readiness
 * gate (e.g. `mapReadyRef`) INSIDE `run` — this queue only serializes; it does
 * not know about map readiness. A `run` that no-ops while not ready is safe:
 * the queue still resolves and is ready to flush the next request.
 *
 * `shouldReplace(pending, incoming)` (optional, defaults to always-true =
 * plain last-write-wins) — PRIORITY-AWARE coalescing (v1.1.9 field-test
 * review fix, Item 3 follow-up): GoogleSatelliteMap shares this queue
 * between a hole-change request (`reason:'hole'` — full clear→frame→add +
 * tee-shot overlays) and a GPS-tick refresh (`reason:'gps'` — overlays only,
 * no camera move, no tee-shot churn). Plain last-write-wins let a `'gps'`
 * request silently EVICT an already-pending `'hole'` request — the trailing
 * run would then execute the cheaper `'gps'` branch, which deliberately
 * skips `fitCameraToHole`/tee-shot overlays, so a hole swipe during an
 * in-flight GPS refresh could drop its camera reframe and tee-shot redraw
 * entirely. The component passes a predicate that returns `false` for
 * `pending.reason==='hole', incoming.reason==='gps'`, so a GPS tick can never
 * evict a pending hole-change (the hole branch already does everything the
 * GPS branch wanted); a pending `'gps'` can still be replaced by a newer
 * `'gps'` or by a `'hole'`.
 *
 * Pure function — no side effects, headless-testable.
 */
export function createCameraQueue<T>(
  run: (target: T) => Promise<void>,
  shouldReplace: (pending: T, incoming: T) => boolean = () => true,
): CameraQueue<T> {
  let inFlight = false;
  let pendingTarget: T | undefined;
  let hasPending = false;

  const start = (target: T): void => {
    inFlight = true;
    void run(target)
      .catch(() => {})
      .then(() => {
        inFlight = false;
        if (hasPending) {
          const next = pendingTarget as T;
          hasPending = false;
          pendingTarget = undefined;
          start(next);
        }
      });
  };

  return {
    request(target: T): void {
      if (!inFlight) {
        start(target);
        return;
      }
      if (hasPending && !shouldReplace(pendingTarget as T, target)) {
        return; // lower-priority incoming request — keep the pending one
      }
      pendingTarget = target;
      hasPending = true;
    },
  };
}

// ── Tee marker colour ──────────────────────────────────────────────────────────

/**
 * Canonical tee-marker colour categories. One bundled PNG per slug, at
 * public/assets/tee-marker-{slug}.png (generated by
 * frontend/scripts/generate-tee-markers.py — keep the rgb values below in
 * sync with that script's COLORS table).
 */
export type TeeColorSlug = 'black' | 'blue' | 'white' | 'gold' | 'red' | 'green' | 'neutral';

export interface TeeColor {
  slug: TeeColorSlug;
  /** Approximate fill colour, matching the bundled PNG (informational — the
   *  marker rendered on the map is always the PNG asset, not this value). */
  rgb: string;
}

/** Calm ink/graphite — shown when the tee name is absent or unrecognised (an
 *  honest "we don't know", never a guessed colour). */
const NEUTRAL_TEE_COLOR: TeeColor = { slug: 'neutral', rgb: '#6b6558' };

/**
 * Priority-ordered alias → canonical-slug rules, case/whitespace-insensitive
 * substring match. Only 7 PNGs are bundled (one per TeeColorSlug), so
 * less-common tee-box names fold onto the closest bundled colour rather than
 * growing the asset set:
 *   • "silver" / "gray" / "grey"  → white (achromatic — nearest bundled colour)
 *   • "combo"  / "orange"        → gold  (warm — nearest bundled colour)
 * None of these alias words overlap, so match order does not affect results.
 */
const TEE_COLOR_RULES: ReadonlyArray<{ slug: TeeColorSlug; rgb: string; match: RegExp }> = [
  { slug: 'black', rgb: '#1f1f1f', match: /black/ },
  { slug: 'blue',  rgb: '#2e5aa8', match: /blue/ },
  { slug: 'white', rgb: '#f2efe6', match: /white|silver|gr[ae]y/ },
  { slug: 'gold',  rgb: '#c99a2e', match: /gold|yellow|combo|orange/ },
  { slug: 'red',   rgb: '#b23a2e', match: /red/ },
  { slug: 'green', rgb: '#2f6b3a', match: /green/ },
];

/**
 * Map a round's tee-name string (e.g. "Black Tees", "gold", "Combo/Forward")
 * to a canonical marker colour. Case/whitespace-insensitive substring match.
 * Absent or unrecognised names return the neutral ink/graphite marker.
 *
 * Pure function — no side effects, headless-testable.
 */
export function teeColorFor(teeName?: string | null): TeeColor {
  const s = (teeName ?? '').trim().toLowerCase();
  if (!s) return NEUTRAL_TEE_COLOR;
  for (const rule of TEE_COLOR_RULES) {
    if (rule.match.test(s)) return { slug: rule.slug, rgb: rule.rgb };
  }
  return NEUTRAL_TEE_COLOR;
}

/** Bundled marker asset path for a tee colour slug (relative — matches the
 *  existing `iconUrl: "assets/tap-target.png"` convention used for the
 *  tap-to-measure reticle). */
export function teeMarkerIconUrl(slug: TeeColorSlug): string {
  return `assets/tee-marker-${slug}.png`;
}

/** Bundled bunker-glyph asset (generated by scripts/generate-bunker-marker.py).
 *  `letter` is `BunkerCarry.letter` ('A'-'F', case-insensitive) — selects the
 *  lettered coin variant; anything else (empty, out-of-range, multi-char,
 *  whitespace) falls back to the plain bean marker. */
export function bunkerMarkerIconUrl(letter: string): string {
  const l = letter.trim().toLowerCase();
  return /^[a-f]$/.test(l) ? `assets/bunker-marker-${l}.png` : 'assets/bunker-marker.png';
}
