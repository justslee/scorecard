/**
 * marker-options — pure builders for native map marker option objects.
 *
 * Pure module: no React, no DOM, no @capacitor/google-maps import. Builds the
 * plain option object the component hands to `map.addMarkers()`, so marker
 * configuration (icon, anchor, orientation) is unit-assertable without a
 * native map. See specs/map-fieldtest-v119-plan.md Item 1.
 */

import type { BunkerCarry, LatLng } from './tee-shot-overlays';
import { bunkerMarkerIconUrl } from './google-map-helpers';

export interface MarkerOption {
  coordinate: LatLng;
  iconUrl: string;
  iconSize: { width: number; height: number };
  iconAnchor: { x: number; y: number };
  isFlat: boolean;
  zIndex: number;
}

/**
 * Build the lettered bunker-badge marker options for `addMarkers()`.
 *
 * `isFlat: false` (billboard — always upright to the screen), NOT flat to
 * the ground. A flat marker rotates with the map's camera bearing (the
 * down-the-line tee->green heading); the letter PNG is baked north-up, so a
 * flat marker inverts (reads upside-down) on any hole whose down-the-line
 * bearing points roughly south. Billboard reads correctly regardless of hole
 * orientation by construction — the camera is already looking down the line.
 * (v1.1.9 field-test fix — GoogleSatelliteMap.tsx previously set
 * `isFlat: true` on this marker.)
 */
export function buildBunkerMarkers(bunkers: readonly BunkerCarry[]): MarkerOption[] {
  return bunkers.map((bunker) => ({
    coordinate: bunker.nearEdge,
    iconUrl: bunkerMarkerIconUrl(bunker.letter),
    iconSize: { width: 26, height: 26 }, // 22 -> 26: room for the coin badge
    iconAnchor: { x: 13, y: 13 },
    isFlat: false,
    zIndex: 4, // under the tee marker's zIndex 5
  }));
}
