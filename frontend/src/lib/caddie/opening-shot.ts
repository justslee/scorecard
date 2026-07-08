import { haversineYards } from "@/lib/map/google-map-helpers";

type LatLng = { lat: number; lng: number };
export type OpeningShot = { distanceYards: number; fromTee?: boolean };

/**
 * Decide the opening recommendation distance-to-pin, honestly.
 *  - GPS path: player's live position -> green, when plausible (1..800y).
 *  - Tee fallback: tee -> green, when GPS is missing/denied/timed-out OR the
 *    GPS distance is implausible. Flagged fromTee:true so the caddie phrases it
 *    honestly ("I'm on the tee ...").
 *  - Honest null: when the green is missing, OR neither a plausible GPS fix nor
 *    tee coords exist. Sheet opens idle.
 *
 * @param gps  Resolved live position, or null (no fix / denied / timeout).
 * @param tee  Hole tee coords, or null.
 * @param green Hole green coords, or null.
 */
export function resolveOpeningShotDistance(
  gps: LatLng | null,
  tee: LatLng | null,
  green: LatLng | null,
): OpeningShot | null {
  if (!green) return null; // no green -> honest null (unchanged early guard)

  // GPS path first — the player's real position wins when plausible.
  if (gps) {
    const d = haversineYards(gps, green);
    if (Number.isFinite(d) && d >= 1 && d <= 800) {
      return { distanceYards: d }; // fromTee falsy -> GPS phrasing
    }
    // implausible GPS -> fall through to tee fallback (do NOT return null yet)
  }

  // Tee fallback — GPS absent/denied/timeout OR implausible.
  // NOTE (specs/caddie-stale-hole-live-plan.md §3.9, diagnosis only — do not
  // "fix" here): an owner report of "231 yards" on a 178y-carded par 3 traced
  // to THIS branch being correct — the tee->green haversine for that hole's
  // ingested tee coordinate really is ~231y, i.e. a mislocated/back-tee OSM
  // coordinate, not a mislabeled branch. Follow-up: audit that hole's
  // ingested tee coordinate against the course card. Not fixed this cycle.
  if (tee) {
    const d = haversineYards(tee, green);
    if (Number.isFinite(d) && d >= 1 && d <= 800) {
      return { distanceYards: d, fromTee: true }; // honest tee phrasing
    }
  }

  return null; // no plausible GPS, no usable tee -> honest idle
}
