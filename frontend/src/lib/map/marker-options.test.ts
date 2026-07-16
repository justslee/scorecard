/**
 * Unit tests for marker-options.ts — the lettered bunker-badge marker option
 * builder (specs/map-fieldtest-v119-plan.md Item 1).
 *
 * Pure geometry/config assertions — no browser APIs, no @capacitor/google-maps.
 * Run: cd frontend && npx vitest run src/lib/map/marker-options.test.ts
 */

import { describe, it, expect } from 'vitest';
import { buildBunkerMarkers } from './marker-options';
import type { BunkerCarry } from './tee-shot-overlays';

function bunker(letter: string, lat = 40.7, lng = -73.5): BunkerCarry {
  return { front: 200, back: 220, side: 'C', nearEdge: { lat, lng }, letter };
}

describe('buildBunkerMarkers — lettered bunker-badge marker options', () => {
  it('every marker is a billboard (isFlat: false) — v1.1.9 upside-down-letter fix', () => {
    const markers = buildBunkerMarkers([bunker('A'), bunker('B'), bunker('C')]);
    expect(markers).toHaveLength(3);
    for (const m of markers) {
      expect(m.isFlat).toBe(false);
    }
  });

  it('iconAnchor is centered at {x:13, y:13} for every marker — no size/anchor regression', () => {
    const markers = buildBunkerMarkers([bunker('A'), bunker('D')]);
    for (const m of markers) {
      expect(m.iconAnchor).toEqual({ x: 13, y: 13 });
    }
  });

  it('maps coordinate from nearEdge and icon URL from letter', () => {
    const [m] = buildBunkerMarkers([bunker('C', 40.71, -73.51)]);
    expect(m.coordinate).toEqual({ lat: 40.71, lng: -73.51 });
    expect(m.iconUrl).toBe('assets/bunker-marker-c.png');
  });

  it('empty input -> empty output', () => {
    expect(buildBunkerMarkers([])).toEqual([]);
  });
});
