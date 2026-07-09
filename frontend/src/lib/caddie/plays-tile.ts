/**
 * plays-tile.ts — pure derivation for the round page's PLAYS tile
 * (specs/physics-tiles-coherence-plan.md §4.3). The tile consumes the
 * backend physics engine's `plays_like_yards` VERBATIM — no local math on
 * the number, ever. This module's only job is deciding WHICH honest number
 * + caption to show: the physics response, or one of the fallback-matrix
 * rows (spec §5) — never the deprecated frontend wind heuristic
 * (lib/map/wind.ts `playsLikeYards`, used in NO cell here).
 *
 * No React, no runtime dependencies — pure primitives in, primitives out
 * (pattern: fcb-labels.ts).
 *
 * Deviation note (plan §4.3 lists a single `basisYards` input; this module
 * takes two — `basisYards` and `fallbackYards`). The fallback matrix (§5)
 * needs two DIFFERENT numbers depending on why physics didn't answer:
 *   - `available:false` (engine explicitly declined, e.g. no club distances
 *     on file) → the PLAIN basis that was actually sent to the physics call
 *     — never elevation-composed (§5's "never a wind/elev claim" row).
 *   - no response at all yet (pending / error / offline / no session /
 *     local round) → the pre-existing RoundPageClient `playsBase` value,
 *     which MAY already be `holeIntel.effectiveYards` (elevation-composed)
 *     — spec §5's deliberate asymmetry: "that number came from the backend
 *     — cached truth, not fabrication — and its caption says 'elev-adj',
 *     claiming nothing more."
 * A single `basisYards` can't represent both without RoundPageClient
 * duplicating this row-selection logic outside the pure/testable module, so
 * the split is kept here instead.
 */

import { playsSubLabel } from "./fcb-labels";
import type { SessionShotDistance } from "./api";

/**
 * Shared with the ELEV tile's "level" threshold (RoundPageClient.tsx) so the
 * two tiles on the same card never contradict each other on a small grade —
 * round-2 review BLOCKING 3: the ELEV tile called a 1-2ft hole "level" while
 * the PLAYS caption claimed "elev-adj" for the same hole. Single source of
 * truth for the CAPTION threshold; the backend physics number may still
 * apply a tiny sub-deadband elevation term to the plays-like YARDAGE — that's
 * real physics, just not worth captioning as an adjustment.
 */
export const ELEV_DEADBAND_FT = 3;

export interface PlaysTileInput {
  /** The physics engine's response for the CURRENT key, or null when no
   *  response has landed yet (pending, error, offline, no session, or a
   *  local round — the hook is disabled in that last case). */
  physics: SessionShotDistance | null;
  /** The RAW basis yardage sent to the physics call this render (§4.2:
   *  live center / cardYards / from-tee center — never effectiveYards).
   *  Shown verbatim only in the `available:false` row. */
  basisYards: number;
  /** RoundPageClient's pre-existing `playsBase` fallback (may already be
   *  `holeIntel.effectiveYards`) — shown only when `physics` is null. */
  fallbackYards: number;
  isLive: boolean;
  fromCard: boolean;
  /** holeIntel != null && !fromCard — drives the fallback's "elev-adj"
   *  caption honesty when `fallbackYards` really is elevation-composed. */
  hasLocalIntel: boolean;
}

export interface PlaysTileDisplay {
  v: string;
  sub: string;
}

export function playsTileDisplay({
  physics,
  basisYards,
  fallbackYards,
  isLive,
  fromCard,
  hasLocalIntel,
}: PlaysTileInput): PlaysTileDisplay {
  if (physics?.available && physics.plays_like_yards != null) {
    const hasWind = physics.conditions_used?.wind_applied === true;
    const elevChange = physics.conditions_used?.elevation_change_ft;
    const hasElev = typeof elevChange === "number" && Math.abs(elevChange) >= ELEV_DEADBAND_FT;
    return {
      v: `${physics.plays_like_yards}Y`,
      sub: playsSubLabel({ hasWind, hasElev, isLive, fromCard }),
    };
  }

  if (physics && physics.available === false) {
    // The engine explicitly declined this shot (e.g. no club distances on
    // file) — the plain request basis, never a wind/elev claim it can't
    // back up (spec §5).
    return {
      v: `${Math.round(basisYards)}Y`,
      sub: playsSubLabel({ hasWind: false, hasElev: false, isLive, fromCard }),
    };
  }

  // physics === null: pending / error / offline / no session / local round.
  // The deprecated wind heuristic is used in NO cell; the elevation term (if
  // any) is the backend's own cached number, not invented locally. In LIVE
  // mode `fallbackYards` is the raw rangefinder center (never elevation-
  // composed — see the module doc) — captioning "elev" there would claim an
  // adjustment never computed (round-2 review BLOCKING 2), so this row can
  // only claim elevation when NOT live (and not card-only, which has no
  // usable intel geometry either).
  return {
    v: `${Math.round(fallbackYards)}Y`,
    sub: playsSubLabel({
      hasWind: false,
      hasElev: hasLocalIntel && !isLive && !fromCard,
      isLive,
      fromCard,
    }),
  };
}
