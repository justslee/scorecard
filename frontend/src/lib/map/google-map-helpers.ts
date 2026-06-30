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
 * Passed directly to `GoogleMap.fitBounds()` to frame the tee→green corridor.
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
